import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'
import { getOrCreateDirectWorkstream } from '@/lib/direct-assignments'


function countWorkingDays(start: Date, end: Date): number {
  let count = 0
  const curr = new Date(start)
  curr.setHours(0, 0, 0, 0)
  const endDay = new Date(end)
  endDay.setHours(23, 59, 59, 999)
  while (curr <= endDay) {
    const dow = curr.getDay()
    if (dow !== 0 && dow !== 6) count++
    curr.setDate(curr.getDate() + 1)
  }
  return Math.max(1, count)
}

export async function PATCH(req: NextRequest, ctx: RouteContext<'/api/requests/[id]'>) {
  try {
    const session = await requireAuth()
    const { id } = await ctx.params
    const data = await req.json()

    const isManager = ['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role)

    // Fetch existing request to get submitter info and fields for task creation
    const existing = await prisma.request.findUnique({
      where: { id },
      select: {
        submitterId: true, title: true, description: true,
        assigneeId: true, assignedById: true, estimatedHours: true,
        isRecurring: true, hoursPerDay: true,
        startDate: true, endDate: true,
        status: true, priority: true,
        submitter: { select: { name: true } },
      },
    })
    if (!existing) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    // Creator can edit their own request as long as it hasn't been converted to a project
    const isOwnRequest = existing.submitterId === session.id && existing.status !== 'CONVERTED'

    // Submitter can only edit their own non-converted request (not status changes, not convert)
    if (!isManager && !isOwnRequest) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Submitter editing own request — only allow field edits, not status/conversion.
    // If only the assignee changed on an APPROVED request, transfer the live task instead
    // of deleting it (avoids the manager needing to re-approve just to reassign).
    if (!isManager && isOwnRequest) {
      const newAssigneeId: string | null = data.assigneeId !== undefined
        ? (data.assigneeId || null)
        : existing.assigneeId
      const assigneeChanging = data.assigneeId !== undefined && data.assigneeId !== existing.assigneeId

      // Detect whether anything OTHER than assignee/assignedBy is changing
      const substantiveChange = data.title !== undefined || data.description !== undefined ||
        data.priority !== undefined || data.type !== undefined ||
        data.startDate !== undefined || data.endDate !== undefined ||
        data.isRecurring !== undefined || data.hoursPerDay !== undefined ||
        data.estimatedHours !== undefined

      const needsResubmit = substantiveChange && ['REVIEW', 'APPROVED'].includes(existing.status)

      if (needsResubmit && existing.status === 'APPROVED' && existing.assigneeId) {
        // Substantive change: pull back the task so manager re-approves
        const directWs = await prisma.workstream.findFirst({
          where: { project: { name: '__direct_assignments__' } },
          select: { id: true },
        })
        if (directWs) {
          await prisma.task.deleteMany({
            where: {
              workstreamId: directWs.id,
              ownerId: existing.assigneeId,
              name: existing.title,
              status: { notIn: ['COMPLETED', 'CANCELLED'] },
            },
          })
        }
        if (existing.assigneeId !== session.id) {
          await prisma.notification.create({
            data: {
              userId: existing.assigneeId,
              senderId: session.id,
              type: 'TASK_UPDATED',
              title: 'Assigned Work Recalled',
              message: `${existing.submitter.name} edited their request "${existing.title}" — it has been resubmitted for approval and the assigned task has been removed.`,
              actionUrl: '/requests',
            },
          })
        }
      } else if (assigneeChanging && existing.status === 'APPROVED' && !substantiveChange) {
        // Only the assignee changed on an APPROVED request: transfer the live task
        const directWs = await prisma.workstream.findFirst({
          where: { project: { name: '__direct_assignments__' } },
          select: { id: true },
        })
        if (directWs) {
          await prisma.task.updateMany({
            where: {
              workstreamId: directWs.id,
              ownerId: existing.assigneeId,
              name: existing.title,
              status: { notIn: ['COMPLETED', 'CANCELLED'] },
            },
            data: { ownerId: newAssigneeId },
          })
        }
        // Notify old assignee task was reassigned
        if (existing.assigneeId && existing.assigneeId !== session.id && existing.assigneeId !== newAssigneeId) {
          await prisma.notification.create({
            data: {
              userId: existing.assigneeId,
              senderId: session.id,
              type: 'TASK_UPDATED',
              title: 'Work Reassigned',
              message: `"${existing.title}" has been reassigned to someone else.`,
              actionUrl: '/kanban',
            },
          })
        }
        // Notify new assignee
        if (newAssigneeId && newAssigneeId !== session.id) {
          await prisma.notification.create({
            data: {
              userId: newAssigneeId,
              senderId: session.id,
              type: 'TASK_ASSIGNED',
              title: 'Work Assigned to You',
              message: `${existing.submitter.name} assigned you to: "${existing.title}". Open Kanban to start.`,
              actionUrl: '/kanban',
            },
          })
        }
        // Signal other tabs to refresh (so Gantt/Kanban/Resources update immediately)
      }

      const updated = await prisma.request.update({
        where: { id },
        data: {
          ...(needsResubmit && { status: 'SUBMITTED' }),
          ...(data.title !== undefined && { title: data.title }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.priority !== undefined && { priority: data.priority }),
          ...(data.type !== undefined && { type: data.type }),
          ...(data.notes !== undefined && { notes: data.notes || null }),
          ...(data.startDate !== undefined && { startDate: data.startDate ? new Date(data.startDate) : null }),
          ...(data.endDate !== undefined && { endDate: data.endDate ? new Date(data.endDate) : null }),
          ...(data.isRecurring !== undefined && { isRecurring: data.isRecurring }),
          ...(data.hoursPerDay !== undefined && { hoursPerDay: data.hoursPerDay ? parseFloat(String(data.hoursPerDay)) : null }),
          ...(data.estimatedHours !== undefined && { estimatedHours: data.estimatedHours ? parseFloat(String(data.estimatedHours)) : null }),
          ...(data.assignedById !== undefined && { assignedById: data.assignedById || null }),
          ...(data.assigneeId !== undefined && { assigneeId: data.assigneeId || null }),
          ...(data.fileLinks !== undefined && { fileLinks: Array.isArray(data.fileLinks) ? data.fileLinks : [] }),
        },
        include: {
          assignee: { select: { id: true, name: true } },
          assignedBy: { select: { id: true, name: true } },
        },
      })

      // Notify the assigner that they need to re-review
      if (needsResubmit && existing.assignedById && existing.assignedById !== session.id) {
        await prisma.notification.create({
          data: {
            userId: existing.assignedById,
            senderId: session.id,
            type: 'APPROVAL_REQUIRED',
            title: 'Request Resubmitted for Review',
            message: `${existing.submitter.name} edited their request "${data.title ?? existing.title}" — please review the updated details.`,
            actionUrl: '/approvals',
          },
        })
      }

      return Response.json(updated)
    }

    // Convert to project
    if (data.status === 'CONVERTED' && data.convertToProject) {
      const project = await prisma.project.create({
        data: {
          name: data.convertToProject.name,
          description: data.convertToProject.description,
          type: data.convertToProject.type,
          status: 'PLANNING',
          priority: data.convertToProject.priority || 'MEDIUM',
          startDate: new Date(data.convertToProject.startDate),
          endDate: new Date(data.convertToProject.endDate),
          leadId: data.convertToProject.leadId || null,
          plannerId: session.id,
        },
      })

      const request = await prisma.request.update({
        where: { id },
        data: { status: 'CONVERTED', projectId: project.id },
        include: { project: true },
      })

      // Notify submitter
      if (existing.submitterId !== session.id) {
        await prisma.notification.create({
          data: {
            userId: existing.submitterId,
            senderId: session.id,
            type: 'APPROVAL_COMPLETED',
            title: 'Request Converted to Project',
            message: `Your request "${existing.title}" has been approved and converted to project "${project.name}".`,
            actionUrl: `/projects/${project.id}`,
          },
        })
      }

      return Response.json(request)
    }

    const request = await prisma.request.update({
      where: { id },
      data: {
        ...(data.status !== undefined && { status: data.status }),
        ...(data.priority !== undefined && { priority: data.priority }),
        ...(data.assigneeId !== undefined && { assigneeId: data.assigneeId || null }),
        ...(data.assignedById !== undefined && { assignedById: data.assignedById || null }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.estimatedHours !== undefined && { estimatedHours: data.estimatedHours ? parseFloat(data.estimatedHours) : null }),
        ...(data.fileLinks !== undefined && { fileLinks: Array.isArray(data.fileLinks) ? data.fileLinks : [] }),
      },
      include: {
        assignee: { select: { id: true, name: true } },
        assignedBy: { select: { id: true, name: true } },
      },
    })

    // When a request transitions to APPROVED for the first time, create a Task for the assignee
    if (data.status === 'APPROVED' && existing.status !== 'APPROVED') {
      const effectiveAssigneeId: string | null = data.assigneeId || existing.assigneeId || null
      if (effectiveAssigneeId) {
        try {
          const workstream = await getOrCreateDirectWorkstream(session.id)
          // For recurring requests, total hours = hoursPerDay × working days in range.
          // For one-off requests, use estimatedHours; fall back to 8h (one workday) if unset.
          const taskHours = existing.isRecurring && existing.hoursPerDay
            ? existing.hoursPerDay * countWorkingDays(
                existing.startDate ?? new Date(),
                existing.endDate ?? new Date(),
              )
            : existing.estimatedHours || 8
          const task = await prisma.task.create({
            data: {
              name: existing.title,
              description: existing.description || null,
              workstreamId: workstream.id,
              ownerId: effectiveAssigneeId,
              // assignedById = who submitted/requested the work; approvedById = who formally approved it
              assignedById: existing.submitterId,
              approvedById: session.id,
              priority: request.priority,
              status: 'PLANNED',
              estimatedHours: taskHours,
              startDate: existing.startDate ?? null,
              endDate: existing.endDate ?? null,
            },
          })
          // Notify the assignee that they have been given work
          if (effectiveAssigneeId !== session.id) {
            const requestedBy = existing.submitterId !== session.id
              ? ` · Requested by ${existing.submitter?.name ?? 'someone'}`
              : ''
            await prisma.notification.create({
              data: {
                userId: effectiveAssigneeId,
                senderId: session.id,
                type: 'TASK_ASSIGNED',
                title: 'Work Assigned — Request Approved',
                message: `${session.name} approved and assigned you: "${existing.title}" · ${taskHours}h${requestedBy}. Open Kanban to start.`,
                taskId: task.id,
                actionUrl: '/kanban',
              },
            })
          }
        } catch (e) {
          console.error('[REQUESTS APPROVE] task creation failed:', e)
          // Non-fatal — the approval still completes
        }
      }
    }

    // Notify newly assigned person
    if (data.assigneeId && data.assigneeId !== session.id) {
      const hours = data.estimatedHours ? ` · ${data.estimatedHours}h estimated` : ''
      await prisma.notification.create({
        data: {
          userId: data.assigneeId,
          senderId: session.id,
          type: 'TASK_ASSIGNED',
          title: 'Request Assigned to You',
          message: `${session.name} assigned you to review the request: "${existing.title}"${hours}`,
          actionUrl: '/approvals',
        },
      })
    }

    // Notify submitter on key status changes
    if (data.status && existing.submitterId !== session.id) {
      const messages: Record<string, string> = {
        REVIEW:   `Your request "${existing.title}" is now under review.`,
        APPROVED: `Your request "${existing.title}" has been approved!`,
        REJECTED: `Your request "${existing.title}" was not approved.`,
      }
      const msg = messages[data.status]
      if (msg) {
        await prisma.notification.create({
          data: {
            userId: existing.submitterId,
            senderId: session.id,
            type: 'APPROVAL_COMPLETED',
            title: data.status === 'APPROVED' ? 'Request Approved' : data.status === 'REJECTED' ? 'Request Rejected' : 'Request Under Review',
            message: msg,
            actionUrl: '/requests',
          },
        })
      }
    }

    return Response.json(request)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/requests/[id]'>) {
  try {
    const session = await requireAuth()
    const { id } = await ctx.params

    const existing = await prisma.request.findUnique({
      where: { id },
      select: {
        submitterId: true,
        assignedById: true,
        assigneeId: true,
        title: true,
        status: true,
      },
    })
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const isSubmitter = existing.submitterId === session.id
    const isAssigner  = existing.assignedById === session.id
    const isManager   = ['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role)
    const canDelete   = (isSubmitter || isAssigner || isManager) && existing.status !== 'CONVERTED'

    if (!canDelete) return Response.json({ error: 'Forbidden' }, { status: 403 })

    // If the request was approved it created a Task in the direct-assignments workstream.
    // Delete that task so the assignee's bandwidth is freed immediately.
    if (existing.status === 'APPROVED' && existing.assigneeId) {
      const directWs = await prisma.workstream.findFirst({
        where: { project: { name: '__direct_assignments__' } },
        select: { id: true },
      })
      if (directWs) {
        await prisma.task.deleteMany({
          where: {
            workstreamId: directWs.id,
            ownerId: existing.assigneeId,
            name: existing.title,
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
          },
        })
      }
    }

    await prisma.request.delete({ where: { id } })
    return Response.json({ ok: true })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
