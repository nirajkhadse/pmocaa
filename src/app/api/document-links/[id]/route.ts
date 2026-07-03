import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'

type Ctx = { params: Promise<{ id: string }> }

// Personal to each user — even ADMIN/MANAGER/PLANNER cannot view, edit, or delete another
// person's entries. A non-owner gets 404 (not 403) so existence of others' entries isn't leaked.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth()
    const { id } = await ctx.params
    const data = await req.json()

    const existing = await prisma.documentLink.findUnique({ where: { id } })
    if (!existing || existing.createdById !== session.id) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    const title = typeof data.title === 'string' ? data.title.trim() : undefined
    const links = Array.isArray(data.links)
      ? data.links.map((l: unknown) => String(l).trim()).filter(Boolean)
      : undefined

    if (title !== undefined && !title) return Response.json({ error: 'Title is required' }, { status: 400 })
    if (links !== undefined && links.length === 0) return Response.json({ error: 'At least one link is required' }, { status: 400 })

    const documentLink = await prisma.documentLink.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(links !== undefined && { links }),
      },
      include: { createdBy: { select: { id: true, name: true } } },
    })
    return Response.json(documentLink)
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

    const existing = await prisma.documentLink.findUnique({ where: { id } })
    if (!existing || existing.createdById !== session.id) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    await prisma.documentLink.delete({ where: { id } })
    return Response.json({ ok: true })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
