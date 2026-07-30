'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuthStore, isPlanner, canAllocateResources } from '@/store/auth'
import { toast } from 'sonner'
import { format } from 'date-fns'
import Link from 'next/link'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  ArrowLeft, Users, Layers, GitBranch, FileText,
  MoreHorizontal, Edit2, Trash2, ShieldCheck, ShieldOff, CalendarRange,
  UserPlus, MessageSquarePlus, AlertTriangle, Siren, Send, CheckCheck,
  Link as LinkIcon, Plus, X, Wand2,
} from 'lucide-react'
import {
  ALL_CATEGORIES, CATEGORY_TYPES, CATEGORY_TYPE_LABELS,
} from '@/lib/project-templates'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { WorkstreamPanel } from '@/components/projects/workstream-panel'
import { ResourceAllocationDialog } from '@/components/projects/resource-allocation-dialog'
import { ProductsPanel } from '@/components/projects/products-panel'
import { ProjectGanttView } from '@/components/projects/project-gantt-view'
import { ProjectSetupWizard } from '@/components/projects/project-setup-wizard'

interface Task {
  id: string; name: string; status: string; priority: string; startDate?: string; endDate?: string
  effortHours: number; owner?: { id: string; name: string; avatarUrl?: string }
}

interface Workstream {
  id: string; name: string; status: string; order: number
  lead?: { id: string; name: string }
  tasks: Task[]
}

interface Allocation {
  userId: string; allocationPct: number
  user: { id: string; name: string; avatarUrl?: string; role: string }
}

interface Project {
  id: string; name: string; description?: string; type: string; status: string
  priority: string; startDate: string; endDate: string
  leadId?: string
  editAccessGranted: boolean
  planStatus: string  // 'DRAFT' | 'SUBMITTED' | 'APPROVED'
  category?: string
  productType?: string
  projectLinks: string[]
  projectClassification?: string
  numberOfProducts?: number
  costRefresh?: boolean
  costRefreshOffset?: number
  lead?: { id: string; name: string; email: string }
  planner?: { id: string; name: string; email: string }
  workstreams: Workstream[]
  allocations: Allocation[]
}

const STATUS_COLORS: Record<string, string> = {
  PLANNING: 'bg-slate-100 text-slate-700', ACTIVE: 'bg-green-100 text-green-700',
  ON_HOLD: 'bg-yellow-100 text-yellow-700', COMPLETED: 'bg-blue-100 text-blue-700',
  CANCELLED: 'bg-red-100 text-red-700',
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { user } = useAuthStore()
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('report')
  const loadInFlightRef = useRef(false)

  // Edit project dialog
  const [editProjectOpen, setEditProjectOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editStatus, setEditStatus] = useState('')
  const [editPriority, setEditPriority] = useState('')
  const [editLeadId, setEditLeadId] = useState<string>('')
  const [editCategory, setEditCategory] = useState('')
  const [editProductType, setEditProductType] = useState('')
  const [editUsers, setEditUsers] = useState<Array<{ id: string; name: string; role: string }>>([])
  const [editSaving, setEditSaving] = useState(false)

  // Edit timeline dialog (PLANNER only)
  const [editTimelineOpen, setEditTimelineOpen] = useState(false)
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [timelineSaving, setTimelineSaving] = useState(false)

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Products for timeline tab strip
  const [timelineProducts, setTimelineProducts] = useState<Array<{ id: string; brand: string; modelNo: string }>>([])
  const [timelineProductId, setTimelineProductId] = useState<string | null>(null)

  // Resource allocation (Team tab, PLANNER only)
  const [addResourceOpen, setAddResourceOpen] = useState(false)
  const [removingUserId, setRemovingUserId] = useState<string | null>(null)

  // Request change (PROJECT_LEAD only)
  const [requestChangeOpen, setRequestChangeOpen] = useState(false)
  const [reqChangeType, setReqChangeType] = useState<string>('RESOURCE_REQUESTED')
  const [reqChangeDesc, setReqChangeDesc] = useState('')
  const [reqChangeSaving, setReqChangeSaving] = useState(false)

  // Plan submission / approval
  const [submittingPlan, setSubmittingPlan] = useState(false)
  const [approvingPlan, setApprovingPlan] = useState(false)

  // Links editing
  const [editLinksOpen, setEditLinksOpen] = useState(false)
  const [editLinks, setEditLinks] = useState<string[]>([])
  const [linksSaving, setLinksSaving] = useState(false)

  // Andon dialog
  const [andonOpen, setAndonOpen] = useState(false)
  const [andonDesc, setAndonDesc] = useState('')
  const [andonSeverity, setAndonSeverity] = useState<string>('HIGH')
  const [andonSaving, setAndonSaving] = useState(false)

  // Cost Refresh toggle
  const [crWarningOpen, setCrWarningOpen] = useState(false)
  const [crPendingEnable, setCrPendingEnable] = useState<boolean>(false)
  const [crToggling, setCrToggling] = useState(false)

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return
    loadInFlightRef.current = true
    try {
      const requestOptions: RequestInit = {
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      }
      const [projRes, prodRes] = await Promise.all([
        fetch(`/api/projects/${id}`, requestOptions),
        fetch(`/api/projects/${id}/products`, requestOptions),
      ])
      if (!projRes.ok) throw new Error('Project could not be loaded')
      const data = await projRes.json()
      setProject(data)
      setLoadError(null)
      const dismissKey = `wizard-dismissed-${id}`
      if (data.workstreams?.length === 0 && !localStorage.getItem(dismissKey)) {
        setWizardOpen(true)
      }
      if (prodRes.ok) {
        const prods = await prodRes.json()
        if (Array.isArray(prods)) {
          setTimelineProducts(prods)
          if (prods.length > 0) setTimelineProductId((prev) => prev ?? prods[0].id)
        }
      }
    } catch {
      setLoadError('This project could not be loaded. Please try again.')
    } finally {
      loadInFlightRef.current = false
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    const initialLoad = window.setTimeout(load, 0)
    return () => window.clearTimeout(initialLoad)
  }, [load])

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="p-6">
        <Card className="max-w-xl">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="h-10 w-10 text-destructive/70 mx-auto mb-3" />
            <p className="font-medium">{loadError ?? 'This project could not be loaded.'}</p>
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="outline" onClick={() => router.push('/projects')}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to projects
              </Button>
              <Button onClick={() => { setLoading(true); load() }}>Try again</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const allTasks = project.workstreams.flatMap((ws) => ws.tasks)
  const progress = allTasks.length
    ? Math.round((allTasks.filter((t) => t.status === 'COMPLETED').length / allTasks.length) * 100)
    : 0

  const userIsPlanner = user && isPlanner(user.role)
  const userIsManager = user?.role === 'MANAGER'
  const userCanAllocate = user && canAllocateResources(user.role)
  const isProjectLead = user?.id === project.leadId
  const canEditProject = userIsPlanner || userIsManager || (isProjectLead && (project.planStatus === 'DRAFT' || project.editAccessGranted))

  // Overdue tasks
  const now = new Date()
  const overdueTasks = allTasks.filter(
    (t) => t.endDate && new Date(t.endDate) < now && !['COMPLETED', 'CANCELLED'].includes(t.status)
  )

  async function syncTemplateTasks() {
    try {
      const res = await fetch(`/api/projects/${id}/sync-template`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const parts: string[] = []
      if (data.added > 0) parts.push(`added ${data.added} task${data.added === 1 ? '' : 's'}`)
      if (data.updated > 0) parts.push(`scheduled ${data.updated} task${data.updated === 1 ? '' : 's'} with dates`)
      if (parts.length === 0) {
        toast.info('All template tasks already present — nothing to add')
      } else {
        toast.success(`Sync complete: ${parts.join(', ')}`)
        load()
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Sync failed')
    }
  }

  async function syncPerProductTasks() {
    try {
      const res = await fetch(`/api/projects/${id}/sync-product-teardown`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      if (data.migrated > 0 || data.ownersUpdated > 0) {
        const parts = []
        if (data.migrated > 0) parts.push(`${data.migrated} workstream(s) created`)
        if (data.ownersUpdated > 0) parts.push(`${data.ownersUpdated} owner(s) reassigned`)
        toast.success(`Per-product tasks synced — ${parts.join(', ')}`)
        load()
      } else {
        toast.info('Per-product tasks already up to date')
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Sync failed')
    }
  }

  async function repairTimeline() {
    try {
      const res = await fetch(`/api/projects/${id}/repair-timeline`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(`Timeline repaired — ${data.updated} task(s) re-sequenced`)
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Repair failed')
    }
  }

  function openEditProject() {
    if (!project) return
    setEditName(project.name)
    setEditStatus(project.status)
    setEditPriority(project.priority)
    setEditLeadId(project.leadId || '')
    setEditCategory(project.category || '')
    setEditProductType(project.productType || '')
    setEditProjectOpen(true)
    if (canEditProject && editUsers.length === 0) {
      fetch('/api/users')
        .then((r) => r.json())
        .then((d) => setEditUsers(Array.isArray(d) ? d.filter((u: { isActive: boolean }) => u.isActive) : []))
    }
  }

  async function saveEditProject() {
    setEditSaving(true)
    try {
      const body: Record<string, unknown> = { name: editName, status: editStatus, priority: editPriority }
      if (canEditProject) {
        body.leadId = editLeadId || null
        body.category = editCategory || null
        body.productType = editProductType || null
      }
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Project updated')
      setEditProjectOpen(false)
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update')
    } finally { setEditSaving(false) }
  }

  function openEditTimeline() {
    if (!project) return
    setEditStart(project.startDate.slice(0, 10))
    setEditEnd(project.endDate.slice(0, 10))
    setEditTimelineOpen(true)
  }

  async function saveTimeline() {
    setTimelineSaving(true)
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: editStart, endDate: editEnd }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Timeline updated')
      setEditTimelineOpen(false)
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update')
    } finally { setTimelineSaving(false) }
  }

  async function toggleEditAccess() {
    if (!project) return
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editAccessGranted: !project.editAccessGranted }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success(project.editAccessGranted ? 'Edit access revoked' : 'Edit access granted to project lead')
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update')
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Project deleted')
      router.push('/projects')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete')
      setDeleting(false)
    }
  }

  async function saveLinks() {
    setLinksSaving(true)
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectLinks: editLinks.filter((l) => l.trim()) }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Links saved')
      setEditLinksOpen(false)
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to save links')
    } finally { setLinksSaving(false) }
  }

  async function removeAllocation(userId: string) {
    setRemovingUserId(userId)
    try {
      const res = await fetch('/api/allocations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, projectId: project!.id }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Resource removed')
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove')
    } finally { setRemovingUserId(null) }
  }

  async function submitRequestChange() {
    if (!reqChangeDesc.trim()) { toast.error('Please describe the change you need'); return }
    setReqChangeSaving(true)
    try {
      const res = await fetch('/api/schedule-changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changeType: reqChangeType,
          description: reqChangeDesc,
          projectId: project!.id,
          affectedTaskIds: [],
          currentData: { projectId: project!.id, projectName: project!.name },
          proposedData: { description: reqChangeDesc },
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Change request submitted to Planner')
      setRequestChangeOpen(false)
      setReqChangeDesc('')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit request')
    } finally { setReqChangeSaving(false) }
  }

  async function submitPlan() {
    setSubmittingPlan(true)
    try {
      const res = await fetch(`/api/projects/${id}/submit-plan`, { method: 'POST' })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Plan submitted to Planner for approval')
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit')
    } finally { setSubmittingPlan(false) }
  }

  async function approvePlan(action: 'approve' | 'reject') {
    setApprovingPlan(true)
    try {
      const res = await fetch(`/api/projects/${id}/approve-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success(action === 'approve' ? 'Plan approved and locked' : 'Plan sent back for revision')
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally { setApprovingPlan(false) }
  }

  async function raiseAndon() {
    if (!andonDesc.trim()) { toast.error('Please describe the issue'); return }
    setAndonSaving(true)
    try {
      const res = await fetch('/api/schedule-changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changeType: 'ANDON_RAISED',
          description: `ANDON raised on "${project!.name}": ${andonDesc}`,
          projectId: project!.id,
          affectedTaskIds: [],
          currentData: { projectId: project!.id, projectName: project!.name },
          proposedData: { issue: andonDesc, severity: andonSeverity },
          impactSummary: { summary: andonDesc, severity: andonSeverity, affectedResources: [], affectedTasks: [], affectedProjects: [project!.name], overloadedResources: [], totalDelayDays: 0 },
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Andon raised — Managers and Planners have been notified')
      setAndonOpen(false)
      setAndonDesc('')
      setAndonSeverity('HIGH')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to raise Andon')
    } finally { setAndonSaving(false) }
  }

  async function confirmCostRefresh() {
    if (!project) return
    setCrToggling(true)
    try {
      const res = await fetch(`/api/projects/${project.id}/cost-refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: crPendingEnable }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success(crPendingEnable ? 'Cost Refresh enabled — Tear Down tasks cancelled and timeline adjusted' : 'Cost Refresh disabled — Tear Down tasks restored')
      setCrWarningOpen(false)
      await load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update Cost Refresh')
    } finally { setCrToggling(false) }
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/projects">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold truncate">{project.name}</h1>
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${STATUS_COLORS[project.status]}`}>
              {project.status.replace('_', ' ')}
            </span>
            {project.type === 'TEARDOWN' && (
              <Badge variant="outline" className="text-xs">Teardown</Badge>
            )}
            {project.category && (
              <Badge variant="outline" className="text-xs text-blue-600 border-blue-300">
                {project.category}{project.productType ? ` · ${project.productType}` : ''}
              </Badge>
            )}
            {project.projectClassification && (
              <Badge variant="outline" className="text-xs text-purple-600 border-purple-300">
                {project.projectClassification}
              </Badge>
            )}
            <Badge variant="outline" className="text-xs">{project.priority}</Badge>
            {/* Plan status badge */}
            {project.planStatus === 'DRAFT' && isProjectLead && (
              <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">Draft</span>
            )}
            {project.planStatus === 'SUBMITTED' && (
              <span className="text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-700 font-medium animate-pulse">Plan Pending Review</span>
            )}
            {project.planStatus === 'APPROVED' && (
              <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 font-medium flex items-center gap-1">
                <CheckCheck className="h-3 w-3" /> Plan Locked
              </span>
            )}
            {project.editAccessGranted && (isProjectLead || userIsPlanner) && project.planStatus !== 'APPROVED' && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 font-medium">
                <ShieldCheck className="h-3 w-3" /> Edit Access Granted
              </span>
            )}
          </div>
          {project.description && (
            <p className="text-muted-foreground text-sm mt-1">{project.description}</p>
          )}
        </div>
        {(canEditProject) && (
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground">
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={openEditProject}>
                <Edit2 className="mr-2 h-4 w-4" /> Edit Project
              </DropdownMenuItem>
              {userIsPlanner && (
                <>
                  <DropdownMenuItem onClick={() => setWizardOpen(true)}>
                    <Wand2 className="mr-2 h-4 w-4 text-blue-600" /> Reconfigure Schedule
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={syncTemplateTasks}>
                    <Plus className="mr-2 h-4 w-4 text-green-600" /> Sync Template Tasks
                  </DropdownMenuItem>
                  {timelineProducts.length > 0 && (
                    <DropdownMenuItem onClick={syncPerProductTasks}>
                      <Plus className="mr-2 h-4 w-4 text-purple-600" /> Sync Per-Product Tasks
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={repairTimeline}>
                    <CalendarRange className="mr-2 h-4 w-4 text-orange-600" /> Repair Timeline
                  </DropdownMenuItem>
                </>
              )}
              {/* Edit Timeline: planners always; project lead once edit access is granted */}
              {(userIsPlanner || (isProjectLead && project.editAccessGranted)) && (
                <DropdownMenuItem onClick={openEditTimeline}>
                  <CalendarRange className="mr-2 h-4 w-4" /> Edit Timeline
                </DropdownMenuItem>
              )}
              {/* Only planners/admins/managers grant or revoke access — a lead can't self-grant */}
              {userIsPlanner && (
                <DropdownMenuItem onClick={toggleEditAccess}>
                  {project.editAccessGranted
                    ? <><ShieldOff className="mr-2 h-4 w-4 text-orange-500" /> Revoke Edit Access</>
                    : <><ShieldCheck className="mr-2 h-4 w-4 text-green-600" /> Grant Edit Access</>
                  }
                </DropdownMenuItem>
              )}
              {(userIsPlanner || userIsManager) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-red-600" onClick={() => setDeleteConfirm(true)}>
                    <Trash2 className="mr-2 h-4 w-4" /> Delete Project
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Cost Refresh toggle — all projects, planner/admin/manager only */}
      {(userIsPlanner || userIsManager) && (
        <div className="flex items-center gap-2">
          <Switch
            checked={!!project.costRefresh}
            onCheckedChange={(checked) => {
              setCrPendingEnable(checked)
              setCrWarningOpen(true)
            }}
            disabled={crToggling}
          />
          <span className="text-sm font-medium">Cost Refresh</span>
          {project.costRefresh && (
            <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
              Teardown skipped · {project.costRefreshOffset}d removed
            </span>
          )}
        </div>
      )}

      {/* Plan action buttons */}
      <div className="flex gap-2 flex-wrap">
        {isProjectLead && project.planStatus === 'DRAFT' && (
          <Button size="sm" onClick={submitPlan} disabled={submittingPlan} className="bg-blue-600 hover:bg-blue-700">
            <Send className="mr-1.5 h-3.5 w-3.5" /> {submittingPlan ? 'Submitting…' : 'Submit Plan'}
          </Button>
        )}
        {isProjectLead && (project.planStatus === 'DRAFT' || project.planStatus === 'SUBMITTED') && (
          <Button size="sm" variant="outline" onClick={() => setAndonOpen(true)} className="text-red-600 border-red-300 hover:bg-red-50">
            <Siren className="mr-1.5 h-3.5 w-3.5" /> Raise Andon
          </Button>
        )}
        {userIsPlanner && project.planStatus === 'SUBMITTED' && (
          <>
            <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => approvePlan('approve')} disabled={approvingPlan}>
              <CheckCheck className="mr-1.5 h-3.5 w-3.5" /> Approve Plan
            </Button>
            <Button size="sm" variant="outline" className="text-orange-600 border-orange-300" onClick={() => approvePlan('reject')} disabled={approvingPlan}>
              Send Back for Revision
            </Button>
          </>
        )}
      </div>

      {/* Approved plan freeze notice */}
      {isProjectLead && project.planStatus === 'APPROVED' && (
        <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm text-green-800 flex items-center gap-2">
          <CheckCheck className="h-4 w-4 shrink-0" />
          <span>The plan has been approved and locked. To make further changes, contact your Planner.</span>
          <Button size="sm" variant="outline" className="ml-auto text-red-600 border-red-300 hover:bg-red-50 shrink-0" onClick={() => setAndonOpen(true)}>
            <Siren className="mr-1.5 h-3.5 w-3.5" /> Raise Andon
          </Button>
        </div>
      )}

      {/* Overdue tasks warning */}
      {overdueTasks.length > 0 && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span><strong>{overdueTasks.length} task{overdueTasks.length > 1 ? 's' : ''}</strong> overdue — project is delayed</span>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Timeline</p>
            <p className="text-sm font-medium mt-0.5">
              {format(new Date(project.startDate), 'MMM d')} – {format(new Date(project.endDate), 'MMM d, yyyy')}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Progress</p>
            <div className="flex items-center gap-2 mt-1">
              <Progress value={progress} className="flex-1 h-1.5" />
              <span className="text-sm font-medium">{progress}%</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Lead</p>
            <p className="text-sm font-medium mt-0.5">{project.lead?.name || '—'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Team</p>
            <div className="flex -space-x-1 mt-1">
              {project.allocations.slice(0, 5).map((a) => (
                <Avatar key={a.userId} className="h-6 w-6 border-2 border-background">
                  <AvatarFallback className="text-xs">
                    {a.user.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                  </AvatarFallback>
                </Avatar>
              ))}
              {project.allocations.length > 5 && (
                <div className="h-6 w-6 rounded-full bg-muted border-2 border-background flex items-center justify-center">
                  <span className="text-xs text-muted-foreground">+{project.allocations.length - 5}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Project Links section */}
      {((project.projectLinks && project.projectLinks.length > 0) || canEditProject) && (
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground shrink-0">
            <LinkIcon className="h-4 w-4" />
            <span className="font-medium">Links:</span>
          </div>
          <div className="flex flex-wrap gap-2 flex-1">
            {(project.projectLinks || []).map((link, i) => (
              <a
                key={i}
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 transition-colors"
              >
                <LinkIcon className="h-3 w-3" />
                {link.length > 50 ? link.slice(0, 47) + '…' : link}
              </a>
            ))}
            {canEditProject && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setEditLinks(project.projectLinks?.length ? [...project.projectLinks] : [''])
                  setEditLinksOpen(true)
                }}
              >
                <Plus className="h-3 w-3 mr-1" />
                {project.projectLinks?.length ? 'Edit Links' : 'Add Link'}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="report">
            <FileText className="mr-1.5 h-3.5 w-3.5" /> Report
          </TabsTrigger>
          <TabsTrigger value="workstreams">
            <Layers className="mr-1.5 h-3.5 w-3.5" /> Timeline
          </TabsTrigger>
          <TabsTrigger value="products">
            <Layers className="mr-1.5 h-3.5 w-3.5" /> Products
          </TabsTrigger>
          <TabsTrigger value="team">
            <Users className="mr-1.5 h-3.5 w-3.5" /> Team
          </TabsTrigger>
          <TabsTrigger value="gantt">
            <GitBranch className="mr-1.5 h-3.5 w-3.5" /> Gantt
          </TabsTrigger>
        </TabsList>

        <TabsContent value="workstreams" className="mt-4">
          {timelineProducts.length > 0 && (
            <div className="flex items-center border-b border-border overflow-x-auto mb-4">
              {timelineProducts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setTimelineProductId(p.id)}
                  className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
                    timelineProductId === p.id
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400 font-medium'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {p.brand}{p.modelNo ? ` ${p.modelNo}` : ''}
                </button>
              ))}
            </div>
          )}
          <WorkstreamPanel
            project={project}
            onRefresh={load}
            productId={timelineProducts.length > 0 ? (timelineProductId ?? undefined) : undefined}
          />
        </TabsContent>

        <TabsContent value="team" className="mt-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Allocated Resources</CardTitle>
                <div className="flex gap-2">
                  {/* PROJECT_LEAD can request resource changes */}
                  {isProjectLead && (
                    <Button size="sm" variant="outline" onClick={() => setRequestChangeOpen(true)}>
                      <MessageSquarePlus className="mr-1.5 h-4 w-4" /> Request Change
                    </Button>
                  )}
                  {/* PLANNER or PROJECT_LEAD can add resources */}
                  {(userCanAllocate || isProjectLead) && (
                    <Button size="sm" onClick={() => setAddResourceOpen(true)} className="bg-blue-600 hover:bg-blue-700">
                      <UserPlus className="mr-1.5 h-4 w-4" /> Add Resource
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {project.allocations.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No resources allocated</p>
                ) : (
                  project.allocations.map((a) => (
                    <div key={a.userId} className="flex items-center gap-3 p-2 rounded-md border">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="text-xs">
                          {a.user.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1">
                        <p className="text-sm font-medium">{a.user.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">{a.user.role.toLowerCase().replace('_', ' ')}</p>
                      </div>
                      <Badge variant="secondary">{a.allocationPct}%</Badge>
                      {(userCanAllocate || isProjectLead) && (
                        <Button
                          size="sm" variant="ghost"
                          className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50"
                          onClick={() => removeAllocation(a.userId)}
                          disabled={removingUserId === a.userId}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="gantt" className="mt-4">
          <ProjectGanttView project={project} onRefresh={load} />
        </TabsContent>

        <TabsContent value="products" className="mt-4">
          <ProductsPanel project={project} onRefresh={load} />
        </TabsContent>

        <TabsContent value="report" className="mt-4">
          <WorkstreamPanel project={project} onRefresh={load} onlyDeliverables />
        </TabsContent>
      </Tabs>

      {/* ── Edit Project Dialog ── */}
      <Dialog open={editProjectOpen} onOpenChange={setEditProjectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit2 className="h-5 w-5" /> Edit Project
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={editStatus} onValueChange={(v) => { const s = v as string | null; if (s) setEditStatus(s) }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PLANNING">Planning</SelectItem>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="ON_HOLD">On Hold</SelectItem>
                    <SelectItem value="COMPLETED">Completed</SelectItem>
                    <SelectItem value="CANCELLED">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={editPriority} onValueChange={(v) => { const s = v as string | null; if (s) setEditPriority(s) }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LOW">Low</SelectItem>
                    <SelectItem value="MEDIUM">Medium</SelectItem>
                    <SelectItem value="HIGH">High</SelectItem>
                    <SelectItem value="CRITICAL">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {/* Lead, Category, Product Type — editable by planners and project lead */}
            {canEditProject && (
              <>
                <div className="space-y-1.5">
                  <Label>Project Lead</Label>
                  <Select
                    value={editLeadId || 'none'}
                    onValueChange={(v) => { const s = v as string | null; setEditLeadId(!s || s === 'none' ? '' : s) }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="No lead assigned">
                        {editUsers.find((u) => u.id === editLeadId)?.name || null}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No lead</SelectItem>
                      {editUsers.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name} ({u.role.replace('_', ' ')})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <Select
                    value={editCategory || 'none'}
                    onValueChange={(v) => { const s = v as string | null; setEditCategory(!s || s === 'none' ? '' : s); setEditProductType('') }}
                  >
                    <SelectTrigger><SelectValue placeholder="Not set" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      {ALL_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {editCategory && editCategory !== 'Other' && (CATEGORY_TYPES[editCategory] ?? []).length > 0 && (
                  <div className="space-y-1.5">
                    <Label>Product Type</Label>
                    <Select
                      value={editProductType || 'none'}
                      onValueChange={(v) => { const s = v as string | null; setEditProductType(!s || s === 'none' ? '' : s) }}
                    >
                      <SelectTrigger><SelectValue placeholder="Not set" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Not set</SelectItem>
                        {(CATEGORY_TYPES[editCategory] ?? []).map((t) => (
                          <SelectItem key={t} value={t}>
                            {(CATEGORY_TYPE_LABELS[editCategory] ?? {})[t] || t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setEditProjectOpen(false)}>Cancel</Button>
              <Button onClick={saveEditProject} disabled={editSaving}>
                {editSaving ? 'Saving…' : 'Save Changes'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit Timeline Dialog (planner, or project lead with granted edit access) ── */}
      <Dialog open={editTimelineOpen} onOpenChange={setEditTimelineOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarRange className="h-5 w-5" /> Edit Timeline
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Start Date</Label>
                <Input type="date" value={editStart} onChange={(e) => setEditStart(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>End Date</Label>
                <Input type="date" value={editEnd} onChange={(e) => setEditEnd(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setEditTimelineOpen(false)}>Cancel</Button>
              <Button onClick={saveTimeline} disabled={timelineSaving}>
                {timelineSaving ? 'Saving…' : 'Update Timeline'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation Dialog ── */}
      {/* Cost Refresh confirmation dialog */}
      <Dialog open={crWarningOpen} onOpenChange={setCrWarningOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className={crPendingEnable ? 'text-amber-600' : 'text-blue-600'}>
              {crPendingEnable ? 'Enable Cost Refresh?' : 'Disable Cost Refresh?'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            {crPendingEnable ? (
              <>
                <p>This will:</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>Cancel all <strong>Tear Down</strong> tasks</li>
                  <li>Shift Costing and subsequent workstream timelines forward</li>
                </ul>
                <p className="text-red-600 font-medium flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Any progress or data saved in Tear Down tasks will be lost and cannot be restored exactly.
                </p>
              </>
            ) : (
              <>
                <p>This will:</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>Restore <strong>Tear Down</strong> tasks to <em>Planned</em> status</li>
                  <li>Shift Costing and subsequent workstream timelines back</li>
                </ul>
                <p className="text-amber-600 font-medium flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Tear Down tasks will be reset — any custom edits made before enabling Cost Refresh are gone.
                </p>
              </>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCrWarningOpen(false)} disabled={crToggling}>Cancel</Button>
            <Button
              onClick={confirmCostRefresh}
              disabled={crToggling}
              className={crPendingEnable ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'}
            >
              {crToggling ? 'Updating…' : 'Confirm'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-red-600">Delete Project</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete <strong>{project.name}</strong> and all its workstreams, tasks, and milestones. This cannot be undone.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete Project'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Request Change Dialog (PROJECT_LEAD) ── */}
      <Dialog open={requestChangeOpen} onOpenChange={setRequestChangeOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquarePlus className="h-5 w-5 text-blue-600" /> Request Change
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Submit a change request to the Planner. They will review it in the Approvals section.
            </p>
            <div className="space-y-1.5">
              <Label>Change Type</Label>
              <Select value={reqChangeType} onValueChange={(v) => { const s = v as string | null; if (s) setReqChangeType(s) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="RESOURCE_REQUESTED">Resource Request (add/change team member)</SelectItem>
                  <SelectItem value="TIMELINE_CHANGE_REQUESTED">Timeline Change (adjust dates)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Description *</Label>
              <Textarea
                rows={3}
                placeholder="Describe what you need and why…"
                value={reqChangeDesc}
                onChange={(e) => setReqChangeDesc(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setRequestChangeOpen(false)}>Cancel</Button>
              <Button onClick={submitRequestChange} disabled={reqChangeSaving} className="bg-blue-600 hover:bg-blue-700">
                {reqChangeSaving ? 'Submitting…' : 'Submit Request'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Andon Dialog ── */}
      <Dialog open={andonOpen} onOpenChange={setAndonOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Siren className="h-5 w-5" /> Raise Andon
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              An Andon raises an urgent alert to all Managers and Planners. Use this when you need immediate attention — blocked work, resource shortage, or a critical issue.
            </p>
            <div className="space-y-1.5">
              <Label>What is the issue? *</Label>
              <Textarea
                rows={3}
                placeholder="Describe the problem, blocker, or escalation…"
                value={andonDesc}
                onChange={(e) => setAndonDesc(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Severity</Label>
              <Select value={andonSeverity} onValueChange={(v) => { const s = v as string | null; if (s) setAndonSeverity(s) }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOW">Low — minor issue, no immediate impact</SelectItem>
                  <SelectItem value="MEDIUM">Medium — affecting progress but manageable</SelectItem>
                  <SelectItem value="HIGH">High — significant blocker requiring fast action</SelectItem>
                  <SelectItem value="CRITICAL">Critical — project at risk, escalate now</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setAndonOpen(false)}>Cancel</Button>
              <Button
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={raiseAndon}
                disabled={andonSaving}
              >
                {andonSaving ? 'Raising…' : 'Raise Andon'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit Links Dialog ── */}
      <Dialog open={editLinksOpen} onOpenChange={setEditLinksOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LinkIcon className="h-5 w-5" /> Project Links
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Add Google Drive folders, spreadsheets, or any relevant links.</p>
            {editLinks.map((link, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input
                  placeholder="https://drive.google.com/..."
                  value={link}
                  onChange={(e) => {
                    const next = [...editLinks]
                    next[i] = e.target.value
                    setEditLinks(next)
                  }}
                  className="text-sm h-8"
                />
                {editLinks.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-red-500"
                    onClick={() => setEditLinks(editLinks.filter((_, j) => j !== i))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs w-full"
              onClick={() => setEditLinks([...editLinks, ''])}
            >
              <Plus className="h-3 w-3 mr-1" /> Add Another Link
            </Button>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setEditLinksOpen(false)}>Cancel</Button>
              <Button onClick={saveLinks} disabled={linksSaving}>
                {linksSaving ? 'Saving…' : 'Save Links'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Resource Allocation Dialog (PLANNER) ── */}
      <ResourceAllocationDialog
        open={addResourceOpen}
        onOpenChange={setAddResourceOpen}
        projectId={project.id}
        existingUserIds={project.allocations.map((a) => a.userId)}
        onAllocated={load}
      />

      {/* ── Project Setup Wizard ── */}
      {wizardOpen && (
        <ProjectSetupWizard
          projectId={project.id}
          projectType={project.type}
          projectClassification={project.projectClassification}
          startDate={project.startDate.slice(0, 10)}
          numberOfProducts={project.numberOfProducts}
          hasWorkstreams={(project.workstreams?.length ?? 0) > 0}
          onComplete={() => {
            setWizardOpen(false)
            localStorage.setItem(`wizard-dismissed-${project.id}`, '1')
            setActiveTab('workstreams')
            load()
          }}
          onDismiss={() => {
            setWizardOpen(false)
            // No localStorage — wizard will re-open next visit until a schedule is generated
          }}
        />
      )}
    </div>
  )
}
