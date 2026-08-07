import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'
import { addWorkingDays } from '@/lib/date-utils'
import { CATEGORY_TEMPLATES } from '@/lib/project-templates'

// DW: Planning(2) + TearDown(5) + Costing(5) = 12 working days before BOB
const DW_BOB_OFFSET = 12
const DW_BOB_DURATION = 2

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth()
    const { id } = await ctx.params
    const products = await prisma.product.findMany({
      where: { projectId: id },
      orderBy: { order: 'asc' },
      include: {
        lead: { select: { id: true, name: true, role: true } },
        resources: {
          include: { user: { select: { id: true, name: true, role: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    return Response.json(products)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth()
    const { id } = await ctx.params

    const project = await prisma.project.findUnique({
      where: { id },
      select: { leadId: true, startDate: true, endDate: true, category: true },
    })
    if (!project) return Response.json({ error: 'Not found' }, { status: 404 })
    const canManage =
      ['ADMIN', 'PLANNER', 'MANAGER'].includes(session.role) ||
      project.leadId === session.id
    if (!canManage) return Response.json({ error: 'Forbidden' }, { status: 403 })

    const data = await req.json()
    const count = await prisma.product.count({ where: { projectId: id } })

    const resources: Array<{ userId: string; subsystems?: string[]; costingTypes?: string[] }> =
      Array.isArray(data.resources) ? data.resources.filter((r: { userId: string }) => r.userId) : []

    const product = await prisma.product.create({
      data: {
        projectId: id,
        brand: data.brand || '',
        modelNo: data.modelNo || '',
        leadId: data.leadId || null,
        resourceCount: data.resourceCount ? parseInt(String(data.resourceCount), 10) : null,
        order: count,
        resources: {
          create: resources.map((r) => ({
            userId: r.userId,
            subsystems: r.subsystems || [],
            costingTypes: r.costingTypes || [],
          })),
        },
      },
      include: {
        lead: { select: { id: true, name: true, role: true } },
        resources: { include: { user: { select: { id: true, name: true, role: true } } } },
      },
    })

    // Write history
    await prisma.productHistory.createMany({
      data: [
        {
          productId: product.id,
          action: 'PRODUCT_CREATED',
          changedById: session.id,
          data: { brand: product.brand, modelNo: product.modelNo },
        },
        ...product.resources.map((r) => ({
          productId: product.id,
          action: 'RESOURCE_ADDED',
          targetUserId: r.userId,
          changedById: session.id,
          data: {
            userName: r.user.name,
            subsystems: r.subsystems,
            costingTypes: r.costingTypes,
          },
        })),
        ...(product.lead && data.leadId
          ? [{
              productId: product.id,
              action: 'LEAD_ASSIGNED',
              changedById: session.id,
              data: { toId: product.lead.id, toName: product.lead.name },
            }]
          : []),
      ],
    })

    // Create per-product BOB & A2Mac1 tasks — auto-create the workstream if needed
    const existingBobWs = await prisma.workstream.findFirst({
      where: { projectId: id, name: 'BOB & A2Mac1' },
    })
    const bobWsOrder = existingBobWs ? 0 : await prisma.workstream.count({ where: { projectId: id } })
    const bobWs = existingBobWs ?? await prisma.workstream.create({
      data: { projectId: id, name: 'BOB & A2Mac1', order: bobWsOrder },
    })
    if (bobWs) {
      const bobStart = project?.startDate ? addWorkingDays(new Date(project.startDate), DW_BOB_OFFSET) : null
      const bobEnd = project?.startDate ? addWorkingDays(new Date(project.startDate), DW_BOB_OFFSET + DW_BOB_DURATION - 1) : null
      const productLabel = `${product.brand}${product.modelNo ? ` ${product.modelNo}` : ''}`
      await prisma.task.createMany({
        data: [
          {
            workstreamId: bobWs.id,
            name: `${productLabel} — A2Mac1`,
            description: `__productTask:${product.id}:a2mac1__`,
            ownerId: product.leadId ?? null,
            startDate: bobStart,
            endDate: bobEnd,
            estimatedHours: 16,
            effortHours: 16,
          },
          {
            workstreamId: bobWs.id,
            name: `${productLabel} — BOB`,
            description: `__productTask:${product.id}:bob__`,
            ownerId: product.leadId ?? null,
            startDate: bobStart,
            endDate: bobEnd,
            estimatedHours: 16,
            effortHours: 16,
          },
        ],
      })
    }

    // Create per-product teardown tasks using the category template
    const template = project.category ? CATEGORY_TEMPLATES[project.category] : undefined
    const tdTaskTemplates = template?.find((ws) => ws.name === 'Tear Down')?.tasks ?? []
    if (tdTaskTemplates.length > 0) {
      const existingTdWs = await prisma.workstream.findFirst({ where: { projectId: id, name: 'Tear Down' } })
      const tdWsOrder = existingTdWs ? 0 : await prisma.workstream.count({ where: { projectId: id } })
      const tdWs = existingTdWs ?? await prisma.workstream.create({ data: { projectId: id, name: 'Tear Down', order: tdWsOrder } })
      // Teardown window: working days 3–7 after project start (after 2 planning days)
      const tdStart = project.startDate ? addWorkingDays(new Date(project.startDate), 2) : null
      const tdEnd = project.startDate ? addWorkingDays(new Date(project.startDate), 6) : null
      const productLabel = `${product.brand}${product.modelNo ? ` ${product.modelNo}` : ''}`
      await prisma.task.createMany({
        data: tdTaskTemplates.flatMap((task) => {
          const assignedUserIds = [...new Set(
            resources.filter((resource) => resource.subsystems?.includes(task.name)).map((resource) => resource.userId)
          )]
          const owners: Array<string | null> = assignedUserIds.length > 0
            ? assignedUserIds
            : [product.leadId ?? null]
          const hoursPerPerson = task.estimatedHours / owners.length
          return owners.map((assignedOwnerId) => ({
            workstreamId: tdWs.id,
            name: `${productLabel} — ${task.name}`,
            description: `__productTask:${product.id}:teardown__`,
            ownerId: assignedOwnerId,
            assignedById: session.id,
            startDate: tdStart,
            endDate: tdEnd,
            estimatedHours: hoursPerPerson,
            effortHours: 0,
          }))
        }),
      })
    }

    return Response.json(product, { status: 201 })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[PRODUCTS POST]', err)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
