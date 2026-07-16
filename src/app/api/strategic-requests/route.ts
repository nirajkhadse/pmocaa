import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'

export async function GET() {
  try {
    const session = await requireAuth()
    const canSeeAll = ['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role)

    const requests = await prisma.strategicRequest.findMany({
      where: canSeeAll ? {} : { submitterId: session.id },
      include: {
        submitter: { select: { id: true, name: true } },
        approver:  { select: { id: true, name: true } },
        tasks: {
          include: { assignee: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
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
    if (!['ADMIN', 'MANAGER', 'PLANNER', 'PROJECT_LEAD'].includes(session.role)) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
    const data = await req.json()
    if (!data.title || !data.startDate) {
      return Response.json({ error: 'Title and start date are required' }, { status: 400 })
    }

    // ADMIN / MANAGER / PLANNER self-approve; PROJECT_LEAD requests go to PENDING_APPROVAL
    const isApprover = ['ADMIN', 'MANAGER', 'PLANNER'].includes(session.role)
    const status = isApprover ? 'ACTIVE' : 'PENDING_APPROVAL'

    const sr = await prisma.strategicRequest.create({
      data: {
        title:       data.title,
        description: data.description || null,
        startDate:   new Date(data.startDate),
        endDate:     data.endDate ? new Date(data.endDate) : null,
        submitterId: session.id,
        fileLinks:   Array.isArray(data.fileLinks) ? data.fileLinks : [],
        status,
        // Self-approve
        ...(isApprover && {
          approvedById: session.id,
          approvedAt:   new Date(),
        }),
      },
      include: {
        submitter: { select: { id: true, name: true } },
        approver:  { select: { id: true, name: true } },
        tasks: { include: { assignee: { select: { id: true, name: true } } } },
      },
    })

    // Notify all active ADMIN / MANAGER / PLANNER users when approval is needed
    if (!isApprover) {
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
            title:     'Strategic Request Pending Approval',
            message:   `${session.name} submitted a strategic request: "${sr.title}"`,
            actionUrl: '/approvals',
          })),
        })
      }
    }

    return Response.json(sr, { status: 201 })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
