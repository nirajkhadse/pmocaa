import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth()
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')

    // Role-based visibility: ADMIN/MANAGER/PLANNER see all; everyone else sees only their own submitted requests
    const roleFilter = ['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role)
      ? {}
      : { submitterId: session.id }

    const requests = await prisma.request.findMany({
      where: { ...roleFilter, ...(status ? { status: status as never } : {}) },
      include: {
        submitter:  { select: { id: true, name: true, avatarUrl: true } },
        assignee:   { select: { id: true, name: true, role: true } },
        assignedBy: { select: { id: true, name: true } },
        project:    { select: { id: true, name: true, status: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
    })
    return Response.json(requests)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth()
    const data = await req.json()

    // RESOURCE can only submit requests for themselves — ignore any passed assigneeId
    const requestedAssigneeIds: string[] = Array.isArray(data.assigneeIds)
      ? data.assigneeIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : (data.assigneeId ? [data.assigneeId] : [])
    const effectiveAssigneeIds = session.role === 'RESOURCE'
      ? [session.id]
      : Array.from(new Set(requestedAssigneeIds.length > 0 ? requestedAssigneeIds : [session.id]))
    const assigneeCount = effectiveAssigneeIds.length
    const totalHours = data.estimatedHours ? parseFloat(String(data.estimatedHours)) : null
    const totalHoursPerDay = data.hoursPerDay ? parseFloat(String(data.hoursPerDay)) : null

    const requests = await prisma.$transaction(effectiveAssigneeIds.map((assigneeId) =>
      prisma.request.create({
        data: {
          title: data.title,
          description: data.description,
          priority: data.priority || 'MEDIUM',
          type: data.type,
          submitterId: session.id,
          assigneeId,
          notes: data.notes,
          startDate: data.startDate ? new Date(data.startDate) : null,
          endDate: data.endDate ? new Date(data.endDate) : null,
          isRecurring: data.isRecurring ?? false,
          hoursPerDay: data.isRecurring && totalHoursPerDay !== null ? totalHoursPerDay / assigneeCount : null,
          estimatedHours: !data.isRecurring && totalHours !== null ? totalHours / assigneeCount : null,
          assignedById: data.assignedById || null,
          fileLinks: Array.isArray(data.fileLinks) ? data.fileLinks : [],
        },
        include: { submitter: { select: { id: true, name: true } } },
      })
    ))

    // Notify all active ADMIN / MANAGER / PLANNER users
    const managers = await prisma.user.findMany({
      where: {
        role: { in: ['ADMIN', 'MANAGER', 'PLANNER'] },
        isActive: true,
        NOT: { id: session.id },
      },
      select: { id: true },
    })

    if (managers.length > 0) {
      await prisma.notification.createMany({
        data: managers.map((m) => ({
          userId: m.id,
          senderId: session.id,
          type: 'APPROVAL_REQUIRED' as const,
          title: 'New Request Submitted',
          message: `${session.name} submitted a new request: "${data.title}"`,
          actionUrl: '/requests',
        })),
      })
    }

    return Response.json(requests.length === 1 ? requests[0] : requests, { status: 201 })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
