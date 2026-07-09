import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'
import { notifyTaskAssigned } from '@/lib/notifications'

const REVIEWER_ROLES = new Set(['ADMIN', 'MANAGER', 'PLANNER', 'PROJECT_LEAD', 'WORKSTREAM_LEAD'])

export async function GET(_req: NextRequest, ctx: RouteContext<'/api/tasks/[id]'>) {
  try {
    await requireAuth()
    const { id } = await ctx.params
    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true, email: true, role: true } },
        assignedBy: { select: { id: true, name: true, avatarUrl: true, role: true } },
        approvedBy: { select: { id: true, name: true, avatarUrl: true, role: true } },
        workstream: { include: { project: true, lead: { select: { id: true, name: true } } } },
        history: {
          orderBy: { changedAt: 'desc' },
          take: 20,
          include: { changedBy: { select: { id: true, name: true } } },
        },
        ownerHistory: {
          orderBy: { changedAt: 'desc' },
          take: 20,
          include: {
            changedBy: { select: { id: true, name: true } },
            fromOwner: { select: { id: true, name: true } },
            toOwner: { select: { id: true, name: true } },
          },
        },
      },
    })
    if (!task) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(task)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext<'/api/tasks/[id]'>) {
  try {
    const session = await requireAuth()
    const { id } = await ctx.params
    const data = await req.json()

    const existing = await prisma.task.findUniqueOrThrow({ where: { id } })
    const statusChanged = data.status !== undefined && data.status !== existing.status

    // Approve/reject (REVIEW → COMPLETED or REWORK) is restricted to whoever assigned the task,
    // or PLANNER/MANAGER/ADMIN. The task owner can never review their own work, regardless of role —
    // UNLESS the task is self-assigned (owner === assigner), in which case no separate reviewer
    // exists and the person may mark their own work complete directly.
    if (statusChanged && existing.status === 'REVIEW' && ['COMPLETED', 'REWORK'].includes(data.status)) {
      const isSelfAssigned = existing.ownerId === session.id && existing.assignedById === session.id
      const canReviewTask =
        isSelfAssigned ||
        (existing.ownerId !== session.id &&
          (existing.assignedById === session.id || REVIEWER_ROLES.has(session.role)))
      if (!canReviewTask) {
        return Response.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // Determine project/workstream-level permissions (one DB call covers all lead checks)
    // Reassigning task owners is normal project-lead housekeeping during planning, gated on plan
    // status like the rest of the app (see workstream-panel.tsx's canAssignTasks). Editing the
    // schedule is the separate, explicitly-granted capability from "Grant Edit Access" — these two
    // must stay independent, or granting/revoking one silently breaks the other.
    let isProjectLeadInDraft = false
    let isProjectLeadWithAccess = false
    let isWorkstreamLead = false
    if (['PROJECT_LEAD', 'WORKSTREAM_LEAD'].includes(session.role)) {
      const ws = await prisma.workstream.findUnique({
        where: { id: existing.workstreamId },
        select: { leadId: true, project: { select: { leadId: true, editAccessGranted: true, planStatus: true } } },
      })
      if (session.role === 'PROJECT_LEAD') {
        const isLead = ws?.project.leadId === session.id
        isProjectLeadInDraft = isLead && ws?.project.planStatus !== 'APPROVED'
        isProjectLeadWithAccess = isLead && !!ws?.project.editAccessGranted
      }
      if (session.role === 'WORKSTREAM_LEAD') isWorkstreamLead = ws?.leadId === session.id
    }
    const canAssign = ['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role) || isProjectLeadInDraft || isWorkstreamLead
    const canEditDates = ['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role) || isProjectLeadWithAccess || isWorkstreamLead
    // Actual dates: the task owner recording their own real progress, or anyone who can edit
    // the original schedule. Previously open to any authenticated user — tightened here.
    const canEditActualDates = canEditDates || existing.ownerId === session.id

    // Only count ownerId as "changed" if the caller is actually allowed to reassign
    const ownerChanged = canAssign && data.ownerId !== undefined && data.ownerId !== existing.ownerId

    // Create history entry and update statusChangedAt when status changes
    if (statusChanged) {
      const durationMinutes = Math.round(
        (Date.now() - existing.statusChangedAt.getTime()) / 60000
      )
      await prisma.taskHistory.create({
        data: {
          taskId: id,
          fromStatus: existing.status,
          toStatus: data.status,
          changedAt: new Date(),
          durationMinutes,
          note: data.reviewNote || data.reworkNote || null,
          changedById: session.id,
        },
      })
    }

    // Log owner change history
    if (ownerChanged) {
      await prisma.taskOwnerHistory.create({
        data: {
          taskId: id,
          fromOwnerId: existing.ownerId || null,
          toOwnerId: data.ownerId || null,
          changedById: session.id,
        },
      })
    }

    const task = await prisma.task.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.status !== undefined && { status: data.status }),
        ...(statusChanged && { statusChangedAt: new Date() }),
        ...(statusChanged && data.status === 'REWORK' && { reworkCount: { increment: 1 } }),
        ...(data.priority !== undefined && { priority: data.priority }),
        // Scheduled (original) dates: ADMIN/MANAGER/PLANNER, workstream lead, or project lead with granted access
        ...(data.startDate !== undefined && canEditDates && {
          startDate: data.startDate ? new Date(data.startDate) : null,
        }),
        ...(data.endDate !== undefined && canEditDates && {
          endDate: data.endDate ? new Date(data.endDate) : null,
        }),
        // Actual dates: task owner, or anyone who can edit the original schedule
        ...(data.actualStartDate !== undefined && canEditActualDates && {
          actualStartDate: data.actualStartDate ? new Date(data.actualStartDate) : null,
        }),
        ...(data.actualEndDate !== undefined && canEditActualDates && {
          actualEndDate: data.actualEndDate ? new Date(data.actualEndDate) : null,
        }),
        ...(data.pctComplete !== undefined && { pctComplete: Math.min(100, Math.max(0, Number(data.pctComplete))) }),
        ...(data.comments !== undefined && { comments: data.comments ?? null }),
        ...(data.effortHours !== undefined && { effortHours: data.effortHours }),
        ...(data.estimatedHours !== undefined && { estimatedHours: data.estimatedHours }),
        ...(data.ownerId !== undefined && canAssign && { ownerId: data.ownerId || null }),
        // Track who reassigned the task
        ...(ownerChanged && { assignedById: session.id }),
        ...(data.order !== undefined && { order: data.order }),
        ...(data.tags !== undefined && { tags: data.tags }),
      },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        workstream: {
          include: {
            project: { select: { id: true, name: true, leadId: true } },
            lead: { select: { id: true, name: true } },
          },
        },
      },
    })

    if (ownerChanged && task.ownerId && task.ownerId !== session.id) {
      await notifyTaskAssigned(
        task.id,
        task.ownerId,
        session.id,
        task.workstream.project.id
      ).catch(console.error)
    }

    // Status-change notifications
    if (statusChanged) {
      const newStatus = data.status as string

      if (newStatus === 'REVIEW') {
        // Determine who to notify — prefer assignedById, fall back to workstream lead, then project lead
        const notifyId =
          (task.assignedById && task.assignedById !== session.id ? task.assignedById : null) ??
          (task.workstream.lead?.id && task.workstream.lead.id !== session.id ? task.workstream.lead.id : null) ??
          (task.workstream.project.leadId && task.workstream.project.leadId !== session.id
            ? task.workstream.project.leadId
            : null)

        if (notifyId) {
          await prisma.notification.create({
            data: {
              type: 'TASK_UPDATED',
              title: 'Task Ready for Review',
              message: `${session.name} submitted "${task.name}" for review.${data.reviewNote ? ` Note: ${data.reviewNote}` : ''}`,
              userId: notifyId,
              senderId: session.id,
              taskId: task.id,
              actionUrl: '/kanban',
            },
          }).catch(console.error)
        }
      } else if (newStatus === 'COMPLETED' && existing.status === 'REVIEW') {
        // Notify the task owner (the one who did the work)
        if (task.ownerId && task.ownerId !== session.id) {
          await prisma.notification.create({
            data: {
              type: 'TASK_UPDATED',
              title: 'Task Approved',
              message: `${session.name} approved your work on '${task.name}' — marked complete!`,
              userId: task.ownerId,
              senderId: session.id,
              taskId: task.id,
              actionUrl: '/kanban',
            },
          }).catch(console.error)
        }
      } else if (newStatus === 'REWORK') {
        // Notify the task owner that it needs rework
        if (task.ownerId && task.ownerId !== session.id) {
          await prisma.notification.create({
            data: {
              type: 'TASK_UPDATED',
              title: 'Task Sent Back for Rework',
              message: `${session.name} sent '${task.name}' back for rework.${data.reworkNote ? ' Note: ' + data.reworkNote : ''}`,
              userId: task.ownerId,
              senderId: session.id,
              taskId: task.id,
              actionUrl: '/kanban',
            },
          }).catch(console.error)
        }
      } else {
        // Any other status change — notify the task owner if someone else moved it
        const STATUS_LABELS: Record<string, string> = {
          BACKLOG: 'moved to Backlog',
          PLANNED: 'planned',
          IN_PROGRESS: 'started',
          COMPLETED: 'marked complete',
          CANCELLED: 'cancelled',
        }
        const label = STATUS_LABELS[newStatus] ?? `moved to ${newStatus}`
        if (task.ownerId && task.ownerId !== session.id) {
          await prisma.notification.create({
            data: {
              type: 'TASK_UPDATED',
              title: 'Task Updated',
              message: `${session.name} ${label} your task "${task.name}".`,
              userId: task.ownerId,
              senderId: session.id,
              taskId: task.id,
              actionUrl: '/kanban',
            },
          }).catch(console.error)
        }
      }
    }

    // Notify assigners/leads when any task reaches COMPLETED
    if (statusChanged && (data.status as string) === 'COMPLETED') {
      const notifySet = new Set<string>()
      if (task.assignedById)                    notifySet.add(task.assignedById)
      if (task.approvedById)                    notifySet.add(task.approvedById)
      if (task.workstream.project.leadId)       notifySet.add(task.workstream.project.leadId)
      if (task.workstream.lead?.id)             notifySet.add(task.workstream.lead.id)
      notifySet.delete(session.id)              // don't notify whoever triggered this
      if (task.ownerId) notifySet.delete(task.ownerId) // owner already notified above if from REVIEW

      for (const userId of notifySet) {
        await prisma.notification.create({
          data: {
            type: 'TASK_UPDATED',
            title: 'Work Completed',
            message: `${task.owner?.name ?? 'A team member'} completed "${task.name}" on ${task.workstream.project.name}.`,
            userId,
            senderId: session.id,
            taskId: task.id,
            projectId: task.workstream.project.id,
            actionUrl: '/kanban',
          },
        }).catch(console.error)
      }
    }

    return Response.json(task)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[TASKS PATCH]', err)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/tasks/[id]'>) {
  try {
    const session = await requireAuth()
    const { id } = await ctx.params
    if (!['ADMIN', 'MANAGER', 'PLANNER', 'WORKSTREAM_LEAD'].includes(session.role)) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
    await prisma.task.delete({ where: { id } })
    return Response.json({ ok: true })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
