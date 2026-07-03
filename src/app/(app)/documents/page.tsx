'use client'

import { useEffect, useState, useMemo } from 'react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { FileText, Search, Plus, Pencil, Trash2, Link as LinkIcon, X } from 'lucide-react'

interface DocumentLinkItem {
  id: string
  title: string
  links: string[]
  createdById: string
  createdBy: { id: string; name: string }
  createdAt: string
}

function emptyForm() {
  return { title: '', links: [''] }
}

export default function DocumentsPage() {
  const [items, setItems] = useState<DocumentLinkItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<DocumentLinkItem | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<DocumentLinkItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  function load() {
    setLoading(true)
    fetch('/api/document-links')
      .then((r) => r.json())
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (i) => i.title.toLowerCase().includes(q) || i.links.some((l) => l.toLowerCase().includes(q))
    )
  }, [items, search])

  function openAdd() {
    setEditing(null)
    setForm(emptyForm())
    setDialogOpen(true)
  }

  function openEdit(item: DocumentLinkItem) {
    setEditing(item)
    setForm({ title: item.title, links: item.links.length ? [...item.links] : [''] })
    setDialogOpen(true)
  }

  function updateLink(i: number, value: string) {
    setForm((f) => {
      const next = [...f.links]
      next[i] = value
      return { ...f, links: next }
    })
  }

  function addLinkField() {
    setForm((f) => ({ ...f, links: [...f.links, ''] }))
  }

  function removeLinkField(i: number) {
    setForm((f) => ({ ...f, links: f.links.filter((_, idx) => idx !== i) }))
  }

  async function handleSave() {
    const title = form.title.trim()
    const links = form.links.map((l) => l.trim()).filter(Boolean)
    if (!title) {
      toast.error('Title is required')
      return
    }
    if (links.length === 0) {
      toast.error('At least one link is required')
      return
    }

    setSaving(true)
    try {
      const res = editing
        ? await fetch(`/api/document-links/${editing.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, links }),
          })
        : await fetch('/api/document-links', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, links }),
          })
      if (!res.ok) {
        const e = await res.json()
        throw new Error(e.error || 'Failed to save')
      }
      toast.success(editing ? 'Document updated' : 'Document added')
      setDialogOpen(false)
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/document-links/${deleteTarget.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const e = await res.json()
        throw new Error(e.error || 'Failed to delete')
      }
      toast.success('Document deleted')
      setDeleteTarget(null)
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Documents</h1>
          <p className="text-muted-foreground text-sm">
            Your personal reference links — visible only to you
          </p>
        </div>
        <Button onClick={openAdd} size="sm" className="bg-blue-600 hover:bg-blue-700">
          <Plus className="mr-1.5 h-4 w-4" /> Add
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search documents..."
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-12 flex flex-col items-center text-center">
            <FileText className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h2 className="text-lg font-semibold mb-2">
              {items.length === 0 ? 'No documents yet' : 'No matches'}
            </h2>
            <p className="text-muted-foreground text-sm max-w-sm">
              {items.length === 0
                ? 'Add a titled link to a drive, doc, or resource — just for you, no one else will see it.'
                : 'Try a different search term.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((item) => (
            <Card key={item.id}>
              <CardContent className="p-4 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm">{item.title}</p>
                  <div className="mt-1.5 space-y-1">
                    {item.links.map((link, i) => (
                      <a
                        key={i}
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs text-blue-600 hover:underline break-all"
                      >
                        <LinkIcon className="h-3 w-3 shrink-0" />
                        {link}
                      </a>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="icon-sm" variant="ghost" onClick={() => openEdit(item)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => setDeleteTarget(item)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Document' : 'Add Document'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Title</label>
              <Input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Team Drive — Design Files"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Links</label>
              <div className="space-y-2">
                {form.links.map((link, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input value={link} onChange={(e) => updateLink(i, e.target.value)} placeholder="https://..." />
                    {form.links.length > 1 && (
                      <Button size="icon-sm" variant="ghost" onClick={() => removeLinkField(i)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <Button size="sm" variant="outline" onClick={addLinkField} className="mt-1">
                <Plus className="mr-1.5 h-3.5 w-3.5" /> Add another link
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null) }}>
        <DialogContent className="max-w-sm sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Document</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Delete &quot;{deleteTarget?.title}&quot;? This can&apos;t be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
