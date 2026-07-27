import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'
import { addWorkingDays, sequenceTasks } from '@/lib/date-utils'
import { CATEGORY_TEMPLATES } from '@/lib/project-templates'

const DW_BOB_OFFSET = 12
const DW_BOB_DURATION = 2

type Ctx = { params: Promise<{ id: string; productId: string }> }

async function canManageProduct(session: { id: string; role: string }, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { leadId: true } })
  return (
    ['ADMIN', 'PLANNER', 'MANAGER'].includes(session.role) ||
    project?.leadId === session.id
  )
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth()
    const { id, productId } = await ctx.params
    if (!(await canManageProduct(session, id))) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }

    const data = await req.json()

    // Fetch current state for diffing
    const current = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        lead: { select: { id: true, name: true } },
        resources: {
          include: { user: { select: { id: true, name: true } } },
        },
      },
    })
    if (!current) return Response.json({ error: 'Not found' }, { status: 404 })

    const historyEntries: Array<{
      productId: string
      action: string
      targetUserId?: string
      changedById: string
      data: Record<string, string | string[] | null>
    }> = []

    // Diff resources
    if (data.resources !== undefined) {
      const oldMap = new Map(current.resources.map((r) => [r.userId, r]))
      const newResources: Array<{ userId: string; subsystems?: string[]; costingTypes?: string[] }> =
        Array.isArray(data.resources) ? data.resources.filter((r: { userId: string }) => r.userId) : []
      const newMap = new Map(newResources.map((r) => [r.userId, r]))

      // Removed
      for (const old of current.resources) {
        if (!newMap.has(old.userId)) {
          historyEntries.push({
            productId,
            action: 'RESOURCE_REMOVED',
            targetUserId: old.userId,
            changedById: session.id,
            data: { userName: old.user.name, subsystems: old.subsystems, costingTypes: old.costingTypes },
          })
        }
      }

      // Added
      for (const nr of newResources) {
        if (!oldMap.has(nr.userId)) {
          const u = await prisma.user.findUnique({ where: { id: nr.userId }, select: { name: true } })
          historyEntries.push({
            productId,
            action: 'RESOURCE_ADDED',
            targetUserId: nr.userId,
            changedById: session.id,
            data: {
              userName: u?.name ?? nr.userId,
              subsystems: nr.subsystems ?? [],
              costingTypes: nr.costingTypes ?? [],
            },
          })
        } else {
          // Changed subsystems or costing
          const old = oldMap.get(nr.userId)!
          const oldSubs = [...old.subsystems].sort().join(',')
          const newSubs = [...(nr.subsystems ?? [])].sort().join(',')
          if (oldSubs !== newSubs) {
            historyEntries.push({
              productId,
              action: 'SUBSYSTEMS_CHANGED',
              targetUserId: nr.userId,
              changedById: session.id,
              data: { userName: old.user.name, from: old.subsystems, to: nr.subsystems ?? [] },
            })
          }
          const oldCts = [...old.costingTypes].sort().join(',')
          const newCts = [...(nr.costingTypes ?? [])].sort().join(',')
          if (oldCts !== newCts) {
            historyEntries.push({
              productId,
              action: 'COSTING_CHANGED',
              targetUserId: nr.userId,
              changedById: session.id,
              data: { userName: old.user.name, from: old.costingTypes, to: nr.costingTypes ?? [] },
            })
          }
        }
      }

      await prisma.productResource.deleteMany({ where: { productId } })
      if (newResources.length > 0) {
        await prisma.productResource.createMany({
          data: newResources.map((r) => ({
            productId,
            userId: r.userId,
            subsystems: r.subsystems || [],
            costingTypes: r.costingTypes || [],
          })),
        })
      }

      // Fetch project dates and product record needed for BOB task dates
      const proj = await prisma.project.findUnique({
        where: { id },
        select: { startDate: true, endDate: true, category: true },
      })
      const productRecord = await prisma.product.findUnique({ where: { id: productId }, select: { brand: true, modelNo: true } })

      // Sync per-product BOB & A2Mac1 tasks — auto-create workstream if needed
      const existingBobWs = await prisma.workstream.findFirst({
        where: { projectId: id, name: 'BOB & A2Mac1' },
      })
      const bobWsOrder2 = existingBobWs ? 0 : await prisma.workstream.count({ where: { projectId: id } })
      const bobWs = existingBobWs ?? await prisma.workstream.create({
        data: { projectId: id, name: 'BOB & A2Mac1', order: bobWsOrder2 },
      })
      const brand = productRecord?.brand ?? ''
      const modelNo = productRecord?.modelNo ?? ''
      const productLabel = `${brand}${modelNo ? ` ${modelNo}` : ''}`

      if (bobWs) {
          await prisma.task.deleteMany({
            where: { workstreamId: bobWs.id, description: { contains: `__productTask:${productId}:` } },
          })
          const bobStart = proj?.startDate ? addWorkingDays(new Date(proj.startDate), DW_BOB_OFFSET) : null
          const bobEnd = proj?.startDate ? addWorkingDays(new Date(proj.startDate), DW_BOB_OFFSET + DW_BOB_DURATION - 1) : null
          await prisma.task.createMany({
            data: [
              {
                workstreamId: bobWs.id,
                name: `${productLabel} — A2Mac1`,
                description: `__productTask:${productId}:a2mac1__`,
                ownerId: data.leadId || current.leadId || null,
                startDate: bobStart,
                endDate: bobEnd,
                estimatedHours: 16,
                effortHours: 16,
              },
              {
                workstreamId: bobWs.id,
                name: `${productLabel} — BOB`,
                description: `__productTask:${productId}:bob__`,
                ownerId: data.leadId || current.leadId || null,
                startDate: bobStart,
                endDate: bobEnd,
                estimatedHours: 16,
                effortHours: 16,
              },
            ],
          })
      }

      // Sync per-product costing task owners — never overwrite dates, status, or pctComplete.
      // If template tasks don't exist yet, create them now so no manual sync step is required.
      const existingCostingWs = await prisma.workstream.findFirst({
        where: { projectId: id, name: { in: ['Costing', 'Product Costing'] } },
      })
      const costingWs = existingCostingWs ?? await prisma.workstream.create({
        data: {
          projectId: id,
          name: 'Costing',
          order: await prisma.workstream.count({ where: { projectId: id } }),
        },
      })

      console.error('[COSTING] wsId=%s category=%s productLabel=%s resources=%j',
        costingWs.id, proj?.category, productLabel,
        newResources.map((r) => ({ uid: r.userId, cts: r.costingTypes })))

      // Remove any stale user×costingType tasks left over from old code
      await prisma.task.deleteMany({
        where: {
          workstreamId: costingWs.id,
          description: { contains: `__productTask:${productId}:costing:` },
        },
      })

      // Find existing template-based costing tasks for this product
      let costingTasks = await prisma.task.findMany({
        where: {
          workstreamId: costingWs.id,
          description: `__productTask:${productId}:costing__`,
        },
        select: { id: true, name: true, ownerId: true },
      })

      console.error('[COSTING] existingTasks=%d: %j', costingTasks.length, costingTasks.map((t) => t.name))

      // Ensure all template tasks exist — create any that are missing (handles both fresh products
      // and products where the template gained new tasks like PCB/Harness after initial sync).
      if (proj?.category) {
        const template = CATEGORY_TEMPLATES[proj.category]
        const tdTaskTemplates = template?.find((ws) => ws.name === 'Tear Down')?.tasks ?? []
        const costTaskTemplates = template?.find((ws) => ws.name === 'Costing')?.tasks ?? []

        console.error('[COSTING] templateTaskCount=%d', costTaskTemplates.length)

        if (costTaskTemplates.length > 0) {
          const existingNames = new Set(costingTasks.map((t) => t.name))
          const missingTasks = costTaskTemplates.filter(
            (task) => !existingNames.has(`${productLabel} — ${task.name}`)
          )

          console.error('[COSTING] missingTasks=%j', missingTasks.map((t) => t.name))

          if (missingTasks.length > 0) {
            const tdAnchor = proj.startDate ? addWorkingDays(new Date(proj.startDate), 2) : null
            const tdDates = tdAnchor && tdTaskTemplates.length > 0 ? sequenceTasks(tdTaskTemplates, tdAnchor) : []
            const tdLastEnd = tdDates.length > 0
              ? tdDates[tdDates.length - 1].endDate
              : (proj.startDate ? addWorkingDays(new Date(proj.startDate), 6) : null)
            const allCostDates = tdLastEnd ? sequenceTasks(costTaskTemplates, addWorkingDays(tdLastEnd, 1)) : []

            await prisma.task.createMany({
              data: missingTasks.map((task) => {
                const i = costTaskTemplates.findIndex((t) => t.name === task.name)
                return {
                  workstreamId: costingWs.id,
                  name: `${productLabel} — ${task.name}`,
                  description: `__productTask:${productId}:costing__`,
                  ownerId: null,
                  startDate: allCostDates[i]?.startDate ?? null,
                  endDate: allCostDates[i]?.endDate ?? null,
                  estimatedHours: task.estimatedHours,
                  effortHours: 0,
                }
              }),
            })

            costingTasks = await prisma.task.findMany({
              where: {
                workstreamId: costingWs.id,
                description: `__productTask:${productId}:costing__`,
              },
              select: { id: true, name: true, ownerId: true },
            })
            console.error('[COSTING] afterCreate taskCount=%d', costingTasks.length)
          }
        }
      }

      // Update ownerId on template tasks: match each task's base name against each resource's
      // costingTypes using bidirectional includes (handles "Packaging & Lit." → task "Packaging",
      // "Tub & Chassis" → task "Tub & Chassis System", etc.)
      if (costingTasks.length > 0) {
        const prefix = `${productLabel} — `
        await Promise.all(
          costingTasks.map((task) => {
            const baseName = task.name.startsWith(prefix)
              ? task.name.slice(prefix.length).toLowerCase()
              : task.name.toLowerCase()
            const match = newResources.find((r) =>
              r.costingTypes?.some((ct) => {
                const c = ct.toLowerCase()
                return c === baseName || c.includes(baseName) || baseName.includes(c)
              })
            )
            const ownerId = match?.userId
            console.error('[COSTING] task=%s baseName=%s -> ownerId=%s', task.name, baseName, ownerId ?? null)
            if (task.ownerId || !ownerId) return Promise.resolve({ count: 0 })
            return prisma.task.updateMany({
              where: { id: task.id, ownerId: null },
              data: { ownerId },
            })
          })
        )
      }
    }

    // Diff lead
    if (data.leadId !== undefined) {
      const oldLeadId = current.leadId ?? null
      const newLeadId = data.leadId || null
      if (oldLeadId !== newLeadId) {
        let toName: string | null = null
        if (newLeadId) {
          const u = await prisma.user.findUnique({ where: { id: newLeadId }, select: { name: true } })
          toName = u?.name ?? null
        }
        historyEntries.push({
          productId,
          action: 'LEAD_CHANGED',
          changedById: session.id,
          data: {
            fromId: oldLeadId,
            fromName: current.lead?.name ?? null,
            toId: newLeadId,
            toName,
          },
        })
      }
    }

    const product = await prisma.product.update({
      where: { id: productId },
      data: {
        ...(data.brand !== undefined && { brand: data.brand }),
        ...(data.modelNo !== undefined && { modelNo: data.modelNo }),
        ...(data.leadId !== undefined && { leadId: data.leadId || null }),
        ...(data.resourceCount !== undefined && {
          resourceCount: data.resourceCount ? parseInt(String(data.resourceCount), 10) : null,
        }),
        ...(data.order !== undefined && { order: data.order }),
      },
      include: {
        lead: { select: { id: true, name: true, role: true } },
        resources: {
          include: { user: { select: { id: true, name: true, role: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (historyEntries.length > 0) {
      await prisma.productHistory.createMany({ data: historyEntries })
    }

    return Response.json(product)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[PRODUCT PATCH]', err)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth()
    const { id, productId } = await ctx.params
    if (!(await canManageProduct(session, id))) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
    // Clean up auto-generated tasks before deleting the product
    const [costingWs, costingWs2, bobWs, tearDownWs] = await Promise.all([
      prisma.workstream.findFirst({ where: { projectId: id, name: 'Product Costing' } }),
      prisma.workstream.findFirst({ where: { projectId: id, name: 'Costing' } }),
      prisma.workstream.findFirst({ where: { projectId: id, name: 'BOB & A2Mac1' } }),
      prisma.workstream.findFirst({ where: { projectId: id, name: 'Tear Down' } }),
    ])
    await Promise.all([
      costingWs && prisma.task.deleteMany({
        where: { workstreamId: costingWs.id, description: { contains: `__productTask:${productId}:` } },
      }),
      costingWs2 && prisma.task.deleteMany({
        where: { workstreamId: costingWs2.id, description: { contains: `__productTask:${productId}:` } },
      }),
      bobWs && prisma.task.deleteMany({
        where: { workstreamId: bobWs.id, description: { contains: `__productTask:${productId}:` } },
      }),
      tearDownWs && prisma.task.deleteMany({
        where: { workstreamId: tearDownWs.id, description: { contains: `__productTask:${productId}:` } },
      }),
    ])
    await prisma.product.delete({ where: { id: productId } })
    return Response.json({ ok: true })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
