import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'
import { getOrCreateDirectWorkstream } from '@/lib/direct-assignments'


export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth()
    const { searchParams } = new URL(req.url)
    const userId = searchParams.get('userId')

    const where: Record<string, unknown> = {
      workstream: { project: { name: '__direct_assignments__' } },
    }
    if (userId) where.ownerId = userId

    if (!['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role)) {
      where.ownerId = session.id
    }

    const tasks = await prisma.task.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true, role: true } },
        workstream: {
          include: { project: { select: { id: true, name: true } } },
        },
      },
      orderBy: [{ startDate: 'asc' }, { createdAt: 'desc' }],
    })

    return Response.json(tasks)
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized')
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth()
    if (!['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role))
      return Response.json({ error: 'Forbidden' }, { status: 403 })

    const data = await req.json()
    const { name, description, ownerId, estimatedHours, startDate, endDate, priority } = data

    if (!name || !ownerId)
      return Response.json({ error: 'name and ownerId are required' }, { status: 400 })

    const workstream = await getOrCreateDirectWorkstream(session.id)

    const task = await prisma.task.create({
      data: {
        name,
        description: description || null,
        workstreamId: workstream.id,
        ownerId,
        assignedById: session.id,
        priority: priority || 'MEDIUM',
        status: 'PLANNED',
        estimatedHours: estimatedHours ? parseFloat(estimatedHours) : 0,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
      },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
      },
    })

    // Notify the assignee
    if (ownerId !== session.id) {
      await prisma.notification.create({
        data: {
          userId: ownerId,
          senderId: session.id,
          type: 'TASK_ASSIGNED',
          title: 'Work Assigned to You',
          message: `${session.name} assigned you: "${name}"${estimatedHours ? ` (${estimatedHours}h estimated)` : ''}${endDate ? ` · due ${new Date(endDate).toLocaleDateString()}` : ''}`,
          actionUrl: '/kanban',
        },
      }).catch((error) => {
        // The assignment is the primary write. A temporary notification
        // failure must not turn a successfully-created task into a 500 response
        // that encourages the user to retry and create a duplicate.
        console.error('[ASSIGNMENT NOTIFICATION]', error)
      })
    }

    return Response.json(task, { status: 201 })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized')
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
