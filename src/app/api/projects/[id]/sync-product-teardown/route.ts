import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'
import { addWorkingDays, sequenceTasks } from '@/lib/date-utils'
import { CATEGORY_TEMPLATES } from '@/lib/project-templates'

type Ctx = { params: Promise<{ id: string }> }

// Generates per-product teardown AND costing tasks for existing products that don't have them.
// Existing task owners are never overwritten: manual assignments must survive page refreshes.
// Safe to call repeatedly.
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth()
    const { id } = await ctx.params

    const project = await prisma.project.findUnique({
      where: { id },
      select: {
        category: true,
        startDate: true,
        products: {
          select: {
            id: true,
            brand: true,
            modelNo: true,
            leadId: true,
            resources: { select: { userId: true, subsystems: true, costingTypes: true } },
          },
          orderBy: { order: 'asc' },
        },
        workstreams: {
          where: { name: { in: ['Tear Down', 'Costing'] } },
          include: { tasks: { select: { id: true, name: true, description: true, ownerId: true } } },
        },
      },
    })
    if (!project) return Response.json({ error: 'Not found' }, { status: 404 })
    if (!project.products.length) return Response.json({ migrated: 0 })

    const template = project.category ? CATEGORY_TEMPLATES[project.category] : undefined
    if (!template) return Response.json({ migrated: 0 })

    const tdTaskTemplates = template.find((ws) => ws.name === 'Tear Down')?.tasks ?? []
    const costTaskTemplates = template.find((ws) => ws.name === 'Costing')?.tasks ?? []

    // Pre-compute sequential dates for each Tear Down subsystem task using half-day packing.
    // All products share the same dates per subsystem (different teams work in parallel).
    const tdAnchor = project.startDate ? addWorkingDays(new Date(project.startDate), 2) : null
    const tdTemplateDates = tdAnchor && tdTaskTemplates.length > 0
      ? sequenceTasks(tdTaskTemplates, tdAnchor)
      : []

    // Costing starts the working day after the last Tear Down task ends.
    const tdLastEnd = tdTemplateDates.length > 0
      ? tdTemplateDates[tdTemplateDates.length - 1].endDate
      : (project.startDate ? addWorkingDays(new Date(project.startDate), 6) : null)

    const costTemplateDates = tdLastEnd && costTaskTemplates.length > 0
      ? sequenceTasks(costTaskTemplates, addWorkingDays(tdLastEnd, 1))
      : []

    let tdWs = project.workstreams.find((w) => w.name === 'Tear Down') ?? null
    let costWs = project.workstreams.find((w) => w.name === 'Costing') ?? null
    let migrated = 0
    let ownersUpdated = 0

    for (const product of project.products) {
      const productLabel = `${product.brand}${product.modelNo ? ` ${product.modelNo}` : ''}`
      const hasTd = tdWs?.tasks.some((t) => t.description?.includes(`__productTask:${product.id}:teardown`))
      const hasCost = costWs?.tasks.some((t) => t.description?.includes(`__productTask:${product.id}:costing`))

      // Migrate Tear Down
      if (!hasTd && tdTaskTemplates.length > 0) {
        if (!tdWs) {
          const order = await prisma.workstream.count({ where: { projectId: id } })
          const created = await prisma.workstream.create({
            data: { projectId: id, name: 'Tear Down', order },
            include: { tasks: { select: { id: true, name: true, description: true, ownerId: true } } },
          })
          tdWs = created
        }
        await prisma.task.createMany({
          data: tdTaskTemplates.flatMap((task, i) => {
            const assignedUserIds = [...new Set(
              product.resources.filter((resource) => resource.subsystems.includes(task.name)).map((resource) => resource.userId)
            )]
            const owners: Array<string | null> = assignedUserIds.length > 0
              ? assignedUserIds
              : [product.leadId ?? null]
            const hoursPerPerson = task.estimatedHours / owners.length
            return owners.map((assignedOwnerId) => ({
              workstreamId: tdWs!.id,
              name: `${productLabel} — ${task.name}`,
              description: `__productTask:${product.id}:teardown__`,
              ownerId: assignedOwnerId,
              startDate: tdTemplateDates[i]?.startDate ?? null,
              endDate: tdTemplateDates[i]?.endDate ?? null,
              estimatedHours: hoursPerPerson,
              effortHours: 0,
            }))
          }),
        })
        migrated++
      }

      // Migrate Costing (template sub-system tasks only — user×costingType tasks are managed separately)
      if (!hasCost && costTaskTemplates.length > 0) {
        if (!costWs) {
          const order = await prisma.workstream.count({ where: { projectId: id } })
          const created = await prisma.workstream.create({
            data: { projectId: id, name: 'Costing', order },
            include: { tasks: { select: { id: true, name: true, description: true, ownerId: true } } },
          })
          costWs = created
        }
        await prisma.task.createMany({
          data: costTaskTemplates.map((task, i) => ({
            workstreamId: costWs!.id,
            name: `${productLabel} — ${task.name}`,
            description: `__productTask:${product.id}:costing__`,
            ownerId: product.leadId ?? null,
            startDate: costTemplateDates[i]?.startDate ?? null,
            endDate: costTemplateDates[i]?.endDate ?? null,
            estimatedHours: task.estimatedHours,
            effortHours: 0,
          })),
        })
        const newlyCreated = await prisma.task.findMany({
          where: { workstreamId: costWs.id, description: `__productTask:${product.id}:costing__` },
          select: { id: true, name: true, description: true, ownerId: true },
        })
        costWs.tasks.push(...newlyCreated.filter((nt) => !costWs!.tasks.some((t) => t.id === nt.id)))
        migrated++
      }

      // Re-sync costing task owners from the product's current resource assignments — matches
      // each task's base name against each resource's costingTypes (subsystem names, or Harness/PCB).
      const productCostTasks = costWs?.tasks.filter(
        (t) => t.description?.includes(`__productTask:${product.id}:costing__`)
      ) ?? []
      if (productCostTasks.length > 0) {
        const prefix = `${productLabel} — `
        const results = await Promise.all(
          productCostTasks.map((task) => {
            const baseName = task.name.startsWith(prefix)
              ? task.name.slice(prefix.length).toLowerCase()
              : task.name.toLowerCase()
            const match = product.resources.find((r) =>
              r.costingTypes?.some((ct) => {
                const c = ct.toLowerCase()
                return c === baseName || c.includes(baseName) || baseName.includes(c)
              })
            )
            if (task.ownerId || !match?.userId) return Promise.resolve({ count: 0 })
            return prisma.task.updateMany({
              where: { id: task.id, ownerId: null },
              data: { ownerId: match.userId },
            })
          })
        )
        ownersUpdated += results.reduce((sum, r) => sum + r.count, 0)
      }
    }

    return Response.json({ migrated, ownersUpdated })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[SYNC-PRODUCT-TEARDOWN]', err)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
