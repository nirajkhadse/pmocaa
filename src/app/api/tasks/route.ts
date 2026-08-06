import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'
import { notifyTaskAssigned } from '@/lib/notifications'


export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth()
    const { searchParams } = new URL(req.url)
    const workstreamId = searchParams.get('workstreamId')
    const ownerId = searchParams.get('ownerId')
    const projectId = searchParams.get('projectId')
    const assignedByMe = searchParams.get('assignedByMe') === 'true'
    // scope=all bypasses role-based filtering (used by Kanban so every user sees all tasks)
    const scopeAll = searchParams.get('scope') === 'all'

    // Build AND conditions so role filter + query params compose safely
    const conditions: object[] = []

    if (workstreamId) conditions.push({ workstreamId })
    if (ownerId)      conditions.push({ ownerId })
    if (projectId)    conditions.push({ workstream: { projectId } })

    if (assignedByMe) {
      // Return tasks the current user assigned or approved — skip role filter
      conditions.push({
        OR: [
          { assignedById: session.id },
          { approvedById: session.id },
        ],
      })
    } else if (!scopeAll) {
      // Role-based access: determines which tasks a user may see at all
      if (session.role === 'RESOURCE') {
        // Tasks assigned to this user, plus work they assigned to someone else.
        // The latter must remain visible when the owner submits it for review so
        // the assigner can approve it or send it back for rework.
        conditions.push({
          OR: [
            { ownerId: session.id },
            { assignedById: session.id },
          ],
        })
      } else if (session.role === 'PROJECT_LEAD') {
        // Tasks in their projects, assigned to them, or assigned by them
        conditions.push({
          OR: [
            { workstream: { project: { leadId: session.id } } },
            { ownerId: session.id },
            { assignedById: session.id },
          ],
        })
      } else if (session.role === 'WORKSTREAM_LEAD') {
        // Tasks in their workstreams, assigned to them, or assigned by them
        conditions.push({
          OR: [
            { workstream: { leadId: session.id } },
            { ownerId: session.id },
            { assignedById: session.id },
          ],
        })
      }
      // ADMIN, MANAGER, PLANNER, LEADERSHIP: no restriction — see all tasks
    }
    // scopeAll=true → no role filter; used by Kanban board for full visibility

    const tasks = await prisma.task.findMany({
      where: conditions.length > 0 ? { AND: conditions } : {},
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        priority: true,
        startDate: true,
        endDate: true,
        effortHours: true,
        estimatedHours: true,
        pctComplete: true,
        actualStartDate: true,
        actualEndDate: true,
        order: true,
        tags: true,
        ownerId: true,
        assignedById: true,
        approvedById: true,
        reworkCount: true,
        statusChangedAt: true,
        workstreamId: true,
        owner: { select: { id: true, name: true, avatarUrl: true } },
        workstream: {
          select: { id: true, name: true, project: { select: { id: true, name: true } } },
        },
      },
      orderBy: [{ order: 'asc' }, { priority: 'asc' }],
    })

    return Response.json(tasks)
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

    // Role check: managers have broad access; PROJECT_LEAD restricted to their own projects (with editAccess)
    if (!['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role)) {
      if (session.role === 'PROJECT_LEAD') {
        const workstream = await prisma.workstream.findUnique({
          where: { id: data.workstreamId },
          include: { project: { select: { leadId: true, editAccessGranted: true } } },
        })
        if (!workstream || workstream.project.leadId !== session.id || !workstream.project.editAccessGranted) {
          return Response.json({ error: 'Forbidden' }, { status: 403 })
        }
      } else {
        return Response.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    const task = await prisma.task.create({
      data: {
        name: data.name,
        description: data.description,
        workstreamId: data.workstreamId,
        ownerId: data.ownerId || null,
        // Auto-attribute: if someone else is being assigned, record who did the assigning
        assignedById: data.assignedById || (data.ownerId && data.ownerId !== session.id ? session.id : null),
        status: data.status || 'BACKLOG',
        priority: data.priority || 'MEDIUM',
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
        effortHours: data.effortHours || 0,
        estimatedHours: data.estimatedHours || 0,
        tags: data.tags || [],
      },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        workstream: {
          include: { project: { select: { id: true, name: true } } },
        },
      },
    })

    if (task.ownerId && task.ownerId !== session.id) {
      await notifyTaskAssigned(
        task.id,
        task.ownerId,
        session.id,
        task.workstream.project.id
      ).catch(console.error)
    }

    return Response.json(task, { status: 201 })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[TASKS POST]', err)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
