import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'

export async function GET() {
  try {
    const session = await requireAuth()
    // Personal to each user — never shown to teammates
    const documentLinks = await prisma.documentLink.findMany({
      where: { createdById: session.id },
      include: {
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    return Response.json(documentLinks)
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

    const title = typeof data.title === 'string' ? data.title.trim() : ''
    const links = Array.isArray(data.links)
      ? data.links.map((l: unknown) => String(l).trim()).filter(Boolean)
      : []

    if (!title) return Response.json({ error: 'Title is required' }, { status: 400 })
    if (links.length === 0) return Response.json({ error: 'At least one link is required' }, { status: 400 })

    const documentLink = await prisma.documentLink.create({
      data: { title, links, createdById: session.id },
      include: { createdBy: { select: { id: true, name: true } } },
    })
    return Response.json(documentLink, { status: 201 })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
