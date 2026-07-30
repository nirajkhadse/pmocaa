'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuthStore, canCreateProject } from '@/store/auth'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Plus, Search, FolderKanban, Calendar, Users, AlertCircle, Copy,
} from 'lucide-react'
import { format, isPast } from 'date-fns'
import { CreateProjectDialog } from '@/components/projects/create-project-dialog'

interface Project {
  id: string; name: string; type: string; status: string; priority: string
  startDate: string; endDate: string
  lead?: { id: string; name: string }
  planner?: { id: string; name: string }
  workstreams: Array<{ tasks: Array<{ id: string; status: string }> }>
  allocations: Array<{ user: { id: string; name: string } }>
  _count: { workstreams: number }
}

interface DuplicatedProduct {
  id: string
  brand: string
  modelNo: string
  order: number
}

const STATUS_COLORS: Record<string, string> = {
  PLANNING: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  ACTIVE: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  ON_HOLD: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  COMPLETED: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
}

const PRIORITY_COLORS: Record<string, string> = {
  LOW: 'border-slate-300 text-slate-500',
  MEDIUM: 'border-blue-300 text-blue-600',
  HIGH: 'border-orange-400 text-orange-600',
  CRITICAL: 'border-red-500 text-red-600',
}

export default function ProjectsPage() {
  const { user } = useAuthStore()
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>('ALL')
  const [typeFilter, setTypeFilter] = useState<string | null>('ALL')
  const [createOpen, setCreateOpen] = useState(false)

  // Duplicate project — Step 1: name + date
  const [dupSource, setDupSource] = useState<Project | null>(null)
  const [dupName, setDupName] = useState('')
  const [dupDate, setDupDate] = useState('')
  const [dupLoading, setDupLoading] = useState(false)

  // Duplicate project — Step 2: rename products
  const [dupProducts, setDupProducts] = useState<DuplicatedProduct[]>([])
  const [dupProjectId, setDupProjectId] = useState<string | null>(null)
  const [dupProductEdits, setDupProductEdits] = useState<Record<string, { brand: string; modelNo: string }>>({})
  const [dupProductSaving, setDupProductSaving] = useState(false)

  function openDuplicate(e: React.MouseEvent, project: Project) {
    e.preventDefault()
    e.stopPropagation()
    setDupSource(project)
    setDupName(`Copy of ${project.name}`)
    setDupDate(project.startDate.slice(0, 10))
    setDupLoading(false)
  }

  async function submitDuplicate() {
    if (!dupSource || !dupName.trim() || !dupDate) return
    setDupLoading(true)
    try {
      const res = await fetch(`/api/projects/${dupSource.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dupName.trim(), startDate: dupDate }),
      })
      if (!res.ok) throw new Error()
      const newProj = await res.json()
      setDupSource(null)
      setDupProjectId(newProj.id)
      const products: DuplicatedProduct[] = newProj.products ?? []
      setDupProducts(products)
      setDupProductEdits(
        Object.fromEntries(products.map((p: DuplicatedProduct) => [p.id, { brand: p.brand, modelNo: p.modelNo }]))
      )
      load()
    } catch {
      alert('Failed to duplicate project')
    } finally {
      setDupLoading(false)
    }
  }

  async function saveDupProducts() {
    if (!dupProjectId) return
    setDupProductSaving(true)
    try {
      await Promise.all(
        dupProducts.map((p) => {
          const edits = dupProductEdits[p.id]
          if (!edits) return Promise.resolve()
          return fetch(`/api/projects/${dupProjectId}/products/${p.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brand: edits.brand, modelNo: edits.modelNo }),
          })
        })
      )
      router.push(`/projects/${dupProjectId}`)
      setDupProjectId(null)
      setDupProducts([])
    } catch {
      alert('Failed to save product names')
    } finally {
      setDupProductSaving(false)
    }
  }

  // Portfolio vs My Projects toggle (only PLANNER has choice; others are fixed)
  const isPlanner = user?.role === 'PLANNER' || user?.role === 'ADMIN'
  const isProjectLead = user?.role === 'PROJECT_LEAD'
  const defaultView = isProjectLead ? 'mine' : 'portfolio'
  const [viewMode, setViewMode] = useState<'portfolio' | 'mine'>(defaultView)
  const loadInFlightRef = useRef(false)

  const pageTitle = isProjectLead ? 'My Projects' : viewMode === 'mine' ? 'My Projects' : 'All Projects'

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return
    loadInFlightRef.current = true
    try {
      const url = viewMode === 'mine' ? '/api/projects?view=mine' : '/api/projects'
      const res = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error('Projects could not be loaded')
      const data = await res.json()
      setProjects(Array.isArray(data) ? data : [])
      setLoadError(null)
    } catch {
      setLoadError('Projects could not be loaded. Please try again.')
    } finally {
      loadInFlightRef.current = false
      setLoading(false)
    }
  }, [viewMode])

  useEffect(() => {
    const initialLoad = window.setTimeout(load, 0)
    // Refresh immediately when switching back to this tab
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(initialLoad)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const filtered = projects.filter((p) => {
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'ALL' || p.status === statusFilter
    const matchType = typeFilter === 'ALL' || p.type === typeFilter
    return matchSearch && matchStatus && matchType
  })

  function getProgress(p: Project) {
    const tasks = p.workstreams.flatMap((w) => w.tasks)
    if (!tasks.length) return 0
    return Math.round((tasks.filter((t) => t.status === 'COMPLETED').length / tasks.length) * 100)
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">{pageTitle}</h1>
          <p className="text-muted-foreground text-sm">{filtered.length} project{filtered.length !== 1 ? 's' : ''}</p>
        </div>

        <div className="flex items-center gap-2">
          {/* View toggle for PLANNER/ADMIN only */}
          {isPlanner && (
            <div className="flex rounded-md border overflow-hidden">
              <button
                onClick={() => setViewMode('portfolio')}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === 'portfolio' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted'}`}
              >
                All Projects
              </button>
              <button
                onClick={() => setViewMode('mine')}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === 'mine' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted'}`}
              >
                My Projects
              </button>
            </div>
          )}

          {user && canCreateProject(user.role) && (
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <Plus className="mr-1 h-4 w-4" /> New Project
            </Button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search projects..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Status</SelectItem>
            <SelectItem value="PLANNING">Planning</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="ON_HOLD">On Hold</SelectItem>
            <SelectItem value="COMPLETED">Completed</SelectItem>
            <SelectItem value="CANCELLED">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Types</SelectItem>
            <SelectItem value="TEARDOWN">Teardown</SelectItem>
            <SelectItem value="OTHER">Other</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loadError && !loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <AlertCircle className="h-12 w-12 text-destructive/70 mb-3" />
          <p className="text-sm font-medium">{loadError}</p>
          <Button className="mt-4" variant="outline" onClick={() => { setLoading(true); load() }}>
            Try again
          </Button>
        </div>
      ) : loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-52 rounded-lg" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <FolderKanban className="h-12 w-12 text-muted-foreground/40 mb-3" />
          <p className="text-muted-foreground">No projects found</p>
          {isProjectLead && (
            <p className="text-muted-foreground text-xs mt-1">Projects will appear here when a Planner assigns you as lead</p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((p) => {
            const progress = getProgress(p)
            const delayed = isPast(new Date(p.endDate)) && p.status !== 'COMPLETED' && p.status !== 'CANCELLED'
            const taskCount = p.workstreams.flatMap((w) => w.tasks).length

            const canDuplicate = user && ['ADMIN', 'MANAGER', 'PLANNER'].includes(user.role)

            return (
              <Link key={p.id} href={`/projects/${p.id}`}>
                <Card className="hover:shadow-md transition-all cursor-pointer border border-border hover:border-primary/30 h-full">
                  <CardContent className="p-4 flex flex-col h-full gap-3">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-semibold text-sm leading-tight line-clamp-2">{p.name}</h3>
                      <div className="flex items-center gap-1 shrink-0">
                        {canDuplicate && (
                          <button
                            onClick={(e) => openDuplicate(e, p)}
                            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            title="Duplicate project"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {delayed && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${STATUS_COLORS[p.status]}`}>
                          {p.status.replace('_', ' ')}
                        </span>
                      </div>
                    </div>

                    <div className="flex gap-1.5 flex-wrap">
                      <Badge variant="outline" className={`text-xs ${PRIORITY_COLORS[p.priority]}`}>
                        {p.priority}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">{p.type}</Badge>
                    </div>

                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Progress</span>
                        <span>{progress}% ({taskCount} tasks)</span>
                      </div>
                      <Progress value={progress} className="h-1.5" />
                    </div>

                    <div className="text-xs text-muted-foreground space-y-1">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="h-3 w-3" />
                        <span>{format(new Date(p.startDate), 'MMM d')} – {format(new Date(p.endDate), 'MMM d, yyyy')}</span>
                      </div>
                      {p.lead && (
                        <div className="flex items-center gap-1.5">
                          <Users className="h-3 w-3" />
                          <span>Lead: {p.lead.name}</span>
                        </div>
                      )}
                      {user?.role === 'RESOURCE' && p.planner && (
                        <div className="flex items-center gap-1.5">
                          <Users className="h-3 w-3" />
                          <span>Assigned by: {p.planner.name}</span>
                        </div>
                      )}
                      {user?.role === 'RESOURCE' && p.allocations.length > 0 && (
                        <div className="flex items-center gap-1.5">
                          <span>Team:</span>
                          <div className="flex -space-x-1">
                            {p.allocations.slice(0, 4).map((a) => (
                              <Avatar key={a.user.id} className="h-4 w-4 border border-background">
                                <AvatarFallback className="text-[9px]">
                                  {a.user.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                                </AvatarFallback>
                              </Avatar>
                            ))}
                            {p.allocations.length > 4 && (
                              <span className="ml-1.5 text-xs">+{p.allocations.length - 4}</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(projectId) => {
          load()
          if (projectId) router.push(`/projects/${projectId}`)
        }}
      />

      {/* Step 1: name + start date */}
      <Dialog open={!!dupSource} onOpenChange={(open) => { if (!open) setDupSource(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Copy className="h-4 w-4" />
              Duplicate Project
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="dup-name">New project name</Label>
              <Input
                id="dup-name"
                value={dupName}
                onChange={(e) => setDupName(e.target.value)}
                placeholder="Project name"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dup-date">New start date</Label>
              <Input
                id="dup-date"
                type="date"
                value={dupDate}
                onChange={(e) => setDupDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Task dates will shift proportionally from this new start date.
                All task progress will be reset to zero.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDupSource(null)}>Cancel</Button>
            <Button
              onClick={submitDuplicate}
              disabled={dupLoading || !dupName.trim() || !dupDate}
            >
              {dupLoading ? 'Creating…' : 'Create Duplicate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Step 2: rename products in the new project */}
      <Dialog open={!!dupProjectId} onOpenChange={(open) => {
        if (!open) { setDupProjectId(null); setDupProducts([]) }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename Products in New Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 max-h-96 overflow-y-auto">
            {dupProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No products in this project.
              </p>
            ) : (
              dupProducts.map((product) => {
                const edits = dupProductEdits[product.id] ?? { brand: product.brand, modelNo: product.modelNo }
                return (
                  <div key={product.id} className="grid grid-cols-2 gap-2 items-center border rounded-lg p-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Brand</Label>
                      <Input
                        value={edits.brand}
                        onChange={(e) => setDupProductEdits((prev) => ({
                          ...prev,
                          [product.id]: { ...edits, brand: e.target.value },
                        }))}
                        placeholder="Brand"
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Model No.</Label>
                      <Input
                        value={edits.modelNo}
                        onChange={(e) => setDupProductEdits((prev) => ({
                          ...prev,
                          [product.id]: { ...edits, modelNo: e.target.value },
                        }))}
                        placeholder="Model No."
                        className="h-8 text-sm"
                      />
                    </div>
                  </div>
                )
              })
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { router.push(`/projects/${dupProjectId!}`); setDupProjectId(null); setDupProducts([]) }}
            >
              Skip
            </Button>
            <Button onClick={saveDupProducts} disabled={dupProductSaving}>
              {dupProductSaving ? 'Saving…' : 'Save & Open Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
