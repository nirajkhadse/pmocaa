import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'

export async function GET(_req: NextRequest, ctx: RouteContext<'/api/projects/[id]'>) {
  try {
    await requireAuth()
    const { id } = await ctx.params
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        lead: { select: { id: true, name: true, avatarUrl: true, email: true } },
        planner: { select: { id: true, name: true, avatarUrl: true, email: true } },
        workstreams: {
          orderBy: { order: 'asc' },
          include: {
            lead: { select: { id: true, name: true } },
            tasks: {
              orderBy: { order: 'asc' },
              include: { owner: { select: { id: true, name: true, avatarUrl: true } } },
            },
          },
        },
        allocations: {
          include: { user: { select: { id: true, name: true, avatarUrl: true, role: true } } },
        },
        scheduleChanges: {
          where: { status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          include: { requester: { select: { id: true, name: true } } },
        },
      },
    })

    if (!project) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(project)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[PROJECT GET]', err)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext<'/api/projects/[id]'>) {
  try {
    const session = await requireAuth()
    const { id } = await ctx.params

    const existing = await prisma.project.findUnique({ where: { id }, select: { leadId: true, editAccessGranted: true, planStatus: true } })
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const isFullAccess = ['ADMIN', 'PLANNER', 'MANAGER'].includes(session.role)
    const isProjectLead = session.role === 'PROJECT_LEAD' && existing.leadId === session.id
    // DRAFT-only lead access: lets the lead edit basic meta fields while still setting up the plan
    const isLeadWithAccess = isProjectLead && existing.planStatus === 'DRAFT'
    // Explicit grant: lets the lead edit the timeline regardless of plan status, until revoked
    const isLeadWithGrantedAccess = isProjectLead && existing.editAccessGranted

    if (!isFullAccess && !isLeadWithAccess && !isLeadWithGrantedAccess) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }

    const data = await req.json()
    const updateData: Record<string, unknown> = {}

    // Fields editable by everyone with any access
    if (data.name !== undefined) updateData.name = data.name
    if (data.description !== undefined) updateData.description = data.description
    if (data.status !== undefined) updateData.status = data.status
    if (data.priority !== undefined) updateData.priority = data.priority
    if (data.projectLinks !== undefined) updateData.projectLinks = data.projectLinks

    // Meta fields: planner/admin/manager OR the project lead (while DRAFT)
    if (isFullAccess || isLeadWithAccess) {
      if (data.leadId !== undefined) updateData.leadId = data.leadId
      if (data.category !== undefined) updateData.category = data.category
      if (data.productType !== undefined) updateData.productType = data.productType
    }

    // Timeline: planner/admin/manager, or the project lead once edit access has been granted
    if (isFullAccess || isLeadWithGrantedAccess) {
      if (data.startDate !== undefined) updateData.startDate = new Date(data.startDate)
      if (data.endDate !== undefined) updateData.endDate = new Date(data.endDate)
    }

    // Privileged fields: PLANNER/ADMIN/MANAGER only — a lead can never grant/revoke their own
    // access or change plan status, even with edit access granted
    if (isFullAccess) {
      if (data.plannerId !== undefined) updateData.plannerId = data.plannerId
      if (data.editAccessGranted !== undefined) updateData.editAccessGranted = data.editAccessGranted
      if (data.planStatus !== undefined) updateData.planStatus = data.planStatus
    }

    const project = await prisma.project.update({ where: { id }, data: updateData })
    return Response.json(project)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/projects/[id]'>) {
  try {
    const session = await requireAuth()
    const { id } = await ctx.params
    if (!['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role)) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
    await prisma.project.delete({ where: { id } })
    return Response.json({ ok: true })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
