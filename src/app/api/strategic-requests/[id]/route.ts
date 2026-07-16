import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'

type Ctx = { params: Promise<{ id: string }> }

const APPROVER_ROLES = ['ADMIN', 'MANAGER', 'PLANNER'] as const

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth()
    const { id } = await ctx.params
    const data = await req.json()

    const existing = await prisma.strategicRequest.findUnique({
      where: { id },
      select: { submitterId: true, status: true, title: true },
    })
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const isApprover = (APPROVER_ROLES as readonly string[]).includes(session.role)
    const isOwner = existing.submitterId === session.id
    const canEdit = isOwner || isApprover
    if (!canEdit) return Response.json({ error: 'Forbidden' }, { status: 403 })

    // ── Approval actions: only ADMIN / MANAGER / PLANNER ─────────────────────
    if (data.action === 'approve') {
      if (!isApprover) return Response.json({ error: 'Forbidden' }, { status: 403 })

      const sr = await prisma.strategicRequest.update({
        where: { id },
        data: {
          status:      'ACTIVE',
          approvedById: session.id,
          approvedAt:  new Date(),
          approvalNote: null,
        },
        include: {
          submitter: { select: { id: true, name: true } },
          approver:  { select: { id: true, name: true } },
          tasks: { include: { assignee: { select: { id: true, name: true } } } },
        },
      })

      // Notify submitter
      if (existing.submitterId !== session.id) {
        await prisma.notification.create({
          data: {
            userId:    existing.submitterId,
            senderId:  session.id,
            type:      'APPROVAL_COMPLETED',
            title:     'Strategic Request Approved',
            message:   `${session.name} approved your strategic request: "${existing.title}"`,
            actionUrl: '/requests',
          },
        }).catch(console.error)
      }

      return Response.json(sr)
    }

    if (data.action === 'reject') {
      if (!isApprover) return Response.json({ error: 'Forbidden' }, { status: 403 })

      const sr = await prisma.strategicRequest.update({
        where: { id },
        data: {
          status:      'REJECTED',
          approvedById: session.id,
          approvedAt:  new Date(),
          approvalNote: data.note?.trim() || null,
        },
        include: {
          submitter: { select: { id: true, name: true } },
          approver:  { select: { id: true, name: true } },
          tasks: { include: { assignee: { select: { id: true, name: true } } } },
        },
      })

      // Notify submitter
      if (existing.submitterId !== session.id) {
        const noteText = data.note?.trim() ? ` Reason: ${data.note.trim()}` : ''
        await prisma.notification.create({
          data: {
            userId:    existing.submitterId,
            senderId:  session.id,
            type:      'APPROVAL_COMPLETED',
            title:     'Strategic Request Rejected',
            message:   `${session.name} rejected your strategic request: "${existing.title}".${noteText}`,
            actionUrl: '/requests',
          },
        }).catch(console.error)
      }

      return Response.json(sr)
    }

    // ── Re-submit a rejected request (owner only) ─────────────────────────────
    if (data.action === 'resubmit') {
      if (!isOwner) return Response.json({ error: 'Forbidden' }, { status: 403 })
      if (existing.status !== 'REJECTED') {
        return Response.json({ error: 'Only rejected requests can be resubmitted' }, { status: 400 })
      }

      const sr = await prisma.strategicRequest.update({
        where: { id },
        data: {
          status:      'PENDING_APPROVAL',
          approvedById: null,
          approvedAt:  null,
          approvalNote: null,
        },
        include: {
          submitter: { select: { id: true, name: true } },
          approver:  { select: { id: true, name: true } },
          tasks: { include: { assignee: { select: { id: true, name: true } } } },
        },
      })

      // Re-notify approvers
      const approvers = await prisma.user.findMany({
        where: { role: { in: ['ADMIN', 'MANAGER', 'PLANNER'] }, isActive: true },
        select: { id: true },
      })
      if (approvers.length > 0) {
        await prisma.notification.createMany({
          data: approvers.map((a) => ({
            userId:    a.id,
            senderId:  session.id,
            type:      'APPROVAL_REQUIRED' as const,
            title:     'Strategic Request Resubmitted',
            message:   `${session.name} resubmitted their strategic request: "${existing.title}"`,
            actionUrl: '/approvals',
          })),
        })
      }

      return Response.json(sr)
    }

    // ── Regular field edits ───────────────────────────────────────────────────
    const sr = await prisma.strategicRequest.update({
      where: { id },
      data: {
        ...(data.title       !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description || null }),
        ...(data.startDate   !== undefined && { startDate: new Date(data.startDate) }),
        ...(data.endDate     !== undefined && { endDate: data.endDate ? new Date(data.endDate) : null }),
        ...(data.status      !== undefined && isApprover && { status: data.status }),
        ...(data.fileLinks   !== undefined && { fileLinks: Array.isArray(data.fileLinks) ? data.fileLinks : [] }),
      },
      include: {
        submitter: { select: { id: true, name: true } },
        approver:  { select: { id: true, name: true } },
        tasks: { include: { assignee: { select: { id: true, name: true } } } },
      },
    })
    return Response.json(sr)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth()
    const { id } = await ctx.params

    const existing = await prisma.strategicRequest.findUnique({ where: { id }, select: { submitterId: true } })
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const canDelete = existing.submitterId === session.id || ['ADMIN', 'PLANNER'].includes(session.role)
    if (!canDelete) return Response.json({ error: 'Forbidden' }, { status: 403 })

    await prisma.strategicRequest.delete({ where: { id } })
    return Response.json({ ok: true })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
