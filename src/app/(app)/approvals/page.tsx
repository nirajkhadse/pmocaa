'use client'

import { useEffect, useState } from 'react'
import { useAuthStore, canApproveChanges } from '@/store/auth'
import { toast } from 'sonner'
import { format, isPast } from 'date-fns'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  CheckCircle2, XCircle, Clock, AlertTriangle, ChevronDown, ChevronUp,
  ClipboardList, UserPlus, Target, Calendar,
} from 'lucide-react'
import { AssignWorkDialog } from '@/components/assign-work-dialog'

// ── Schedule Change types ───────────────────────────────────────────────────
interface ImpactItem { id: string; name: string; type: string; delayDays?: number; reason: string }
interface ImpactSummary {
  affectedTasks: ImpactItem[]; affectedProjects: ImpactItem[]; affectedResources: ImpactItem[]
  overloadedResources: string[]; totalDelayDays: number; severity: string; summary: string
}
interface ScheduleChange {
  id: string; changeType: string; description: string; status: string
  createdAt: string; impactSummary: ImpactSummary
  currentData: Record<string, unknown>; proposedData: Record<string, unknown>
  requester: { id: string; name: string; avatarUrl?: string }
  project?: { id: string; name: string }
  approval?: { id: string; approver?: { name: string }; comments?: string }
}

// ── Request types ───────────────────────────────────────────────────────────
interface WorkRequest {
  id: string; title: string; description: string; priority: string
  type: string; status: string; notes?: string; createdAt: string
  estimatedHours?: number
  submitter: { id: string; name: string }
  assignee?: { id: string; name: string }
  project?: { id: string; name: string }
}
interface TeamMember { id: string; name: string; role: string; capacityPct: number; department?: string }
interface AssigneeTask {
  id: string; name: string; status: string; priority: string
  startDate?: string; endDate?: string
  effortHours: number; estimatedHours: number
  workstream: { name: string; project: { name: string } }
}

// ── Strategic Request types ─────────────────────────────────────────────────
interface StrategicRequestApproval {
  id: string; title: string; description?: string; status: string
  startDate: string; endDate?: string; createdAt: string
  fileLinks?: string[]
  submitter: { id: string; name: string }
  approver?: { id: string; name: string }
  approvalNote?: string
  tasks: Array<{ id: string; title: string; assignee?: { name: string } }>
}

const SEVERITY_COLORS: Record<string, string> = {
  LOW: 'text-green-600 bg-green-50', MEDIUM: 'text-blue-600 bg-blue-50',
  HIGH: 'text-orange-600 bg-orange-50', CRITICAL: 'text-red-600 bg-red-50',
}
const CHANGE_TYPE_LABELS: Record<string, string> = {
  TASK_ADDED: 'Task Added', TASK_PRIORITY_CHANGED: 'Priority Changed',
  TASK_DURATION_CHANGED: 'Duration Changed', RESOURCE_OVERLOAD: 'Resource Overload',
  RESOURCE_UNAVAILABLE: 'Resource Unavailable', PROJECT_PRIORITY_CHANGED: 'Project Priority Changed',
  TASK_DATES_CHANGED: 'Task Dates Changed', ANDON_RAISED: 'Andon Alert',
}
const REQ_STATUS_COLORS: Record<string, string> = {
  SUBMITTED: 'bg-slate-100 text-slate-700', REVIEW: 'bg-yellow-100 text-yellow-700',
  APPROVED: 'bg-green-100 text-green-700', REJECTED: 'bg-red-100 text-red-700', CONVERTED: 'bg-blue-100 text-blue-700',
}

export default function ApprovalsPage() {
  const { user } = useAuthStore()
  const [tab, setTab] = useState<'requests' | 'strategic' | 'schedule'>('requests')

  // Schedule changes state
  const [changes,      setChanges]      = useState<ScheduleChange[]>([])
  const [changesLoad,  setChangesLoad]  = useState(true)
  const [selected,     setSelected]     = useState<ScheduleChange | null>(null)
  const [comments,     setComments]     = useState('')
  const [processing,      setProcessing]      = useState(false)
  const [expanded,        setExpanded]        = useState<Record<string, boolean>>({})
  const [scFilter,        setScFilter]        = useState('PENDING')
  const [andonDelayDays,  setAndonDelayDays]  = useState<string>('')

  // Work requests state
  const [wRequests,    setWRequests]    = useState<WorkRequest[]>([])
  const [wLoad,        setWLoad]        = useState(true)
  const [wFilter,      setWFilter]      = useState('ALL_OPEN')
  const [actionLoad,   setActionLoad]   = useState<string | null>(null)

  // Approval impact dialog
  const [approveTarget,        setApproveTarget]        = useState<WorkRequest | null>(null)
  const [assigneeTasks,        setAssigneeTasks]        = useState<AssigneeTask[]>([])
  const [assigneeTasksLoading, setAssigneeTasksLoading] = useState(false)
  const [approving,            setApproving]            = useState(false)

  // Assignment state
  const [teamMembers,   setTeamMembers]   = useState<TeamMember[]>([])
  const [assignDialogOpen, setAssignDialogOpen] = useState(false)
  // Inline per-request assignment fields (keyed by requestId)
  const [inlineAssign,  setInlineAssign]  = useState<Record<string, { assigneeId: string; estimatedHours: string }>>({})
  const [savingAssign,  setSavingAssign]  = useState<string | null>(null)

  // Strategic requests state
  const [srRequests,     setSrRequests]     = useState<StrategicRequestApproval[]>([])
  const [srLoad,         setSrLoad]         = useState(false)
  const [srActionLoad,   setSrActionLoad]   = useState<string | null>(null)
  const [srRejectTarget, setSrRejectTarget] = useState<StrategicRequestApproval | null>(null)
  const [srRejectNote,   setSrRejectNote]   = useState('')
  const [srRejecting,    setSrRejecting]    = useState(false)

  const canApprove = user && canApproveChanges(user.role)

  // ── Load schedule changes
  const loadChanges = async () => {
    setChangesLoad(true)
    try {
      const res = await fetch(`/api/schedule-changes?status=${scFilter}`)
      const data = await res.json()
      setChanges(Array.isArray(data) ? data : [])
    } catch { toast.error('Failed to load schedule changes') }
    finally { setChangesLoad(false) }
  }

  // ── Load work requests
  const loadRequests = async () => {
    setWLoad(true)
    try {
      const url = wFilter === 'ALL_OPEN' ? '/api/requests' : `/api/requests?status=${wFilter}`
      const res = await fetch(url)
      if (!res.ok) { toast.error('Failed to load requests'); setWLoad(false); return }
      const data = await res.json()
      // For ALL_OPEN, only show non-terminal statuses
      const filtered = wFilter === 'ALL_OPEN'
        ? (Array.isArray(data) ? data.filter((r: WorkRequest) => !['CONVERTED', 'REJECTED'].includes(r.status)) : [])
        : (Array.isArray(data) ? data : [])
      setWRequests(filtered)
    } catch { toast.error('Failed to load requests') }
    finally { setWLoad(false) }
  }

  const loadStrategicRequests = async () => {
    setSrLoad(true)
    try {
      const res = await fetch('/api/strategic-requests')
      if (!res.ok) return
      const data = await res.json()
      setSrRequests(Array.isArray(data) ? data.filter((r: StrategicRequestApproval) => r.status === 'PENDING_APPROVAL') : [])
    } catch { toast.error('Failed to load strategic requests') }
    finally { setSrLoad(false) }
  }

  useEffect(() => { loadChanges() }, [scFilter])
  useEffect(() => { loadRequests() }, [wFilter])
  // Always load strategic requests on mount so the badge count is correct
  // and re-load whenever the strategic tab is selected
  useEffect(() => { if (canApprove) loadStrategicRequests() }, [canApprove])
  useEffect(() => { if (tab === 'strategic' && canApprove) loadStrategicRequests() }, [tab])

  // Auto-switch tab based on URL hash (e.g. /approvals#strategic from notification link)
  useEffect(() => {
    const hash = window.location.hash.replace('#', '')
    if (hash === 'strategic' || hash === 'schedule' || hash === 'requests') {
      setTab(hash as 'requests' | 'strategic' | 'schedule')
    }
  }, [])


  // Load team members for assignee dropdowns
  useEffect(() => {
    if (!canApprove) return
    fetch('/api/users')
      .then(r => r.json())
      .then(d => setTeamMembers(Array.isArray(d) ? d.filter((u: TeamMember & { isActive: boolean }) => u.isActive) : []))
  }, [canApprove])

  async function saveInlineAssign(reqId: string) {
    const vals = inlineAssign[reqId]
    if (!vals?.assigneeId && !vals?.estimatedHours) return
    setSavingAssign(reqId)
    try {
      const body: Record<string, unknown> = {}
      if (vals.assigneeId) body.assigneeId = vals.assigneeId
      if (vals.estimatedHours) body.estimatedHours = parseFloat(vals.estimatedHours)
      const res = await fetch(`/api/requests/${reqId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Assignment saved')
      setInlineAssign(prev => { const n = { ...prev }; delete n[reqId]; return n })
      loadRequests()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setSavingAssign(null) }
  }

  // ── Schedule change actions
  async function handleDecision(approved: boolean) {
    if (!selected) return
    setProcessing(true)
    try {
      const body: Record<string, unknown> = { approved, comments }
      if (selected.changeType === 'ANDON_RAISED' && andonDelayDays !== '') {
        body.delayDays = Number(andonDelayDays)
      }
      const res = await fetch(`/api/schedule-changes/${selected.id}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error()
      toast.success(approved ? 'Change approved and applied' : 'Change rejected')
      setSelected(null); setComments(''); setAndonDelayDays(''); loadChanges()
    } catch { toast.error('Failed to process approval') }
    finally { setProcessing(false) }
  }

  // ── Request actions
  async function updateRequestStatus(id: string, status: string) {
    setActionLoad(id + status)
    try {
      const res = await fetch(`/api/requests/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success(`Request moved to ${status.toLowerCase()}`)
      loadRequests()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setActionLoad(null) }
  }

  async function openApproveDialog(req: WorkRequest) {
    setApproveTarget(req)
    setAssigneeTasks([])

    if (req.assignee?.id) {
      setAssigneeTasksLoading(true)
      try {
        const res = await fetch(`/api/tasks?ownerId=${req.assignee.id}`)
        const data = await res.json()
        setAssigneeTasks(Array.isArray(data) ? data : [])
      } finally {
        setAssigneeTasksLoading(false)
      }
    }
  }

  async function handleApprove() {
    if (!approveTarget) return
    setApproving(true)
    try {
      const res = await fetch(`/api/requests/${approveTarget.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'APPROVED' }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Request approved')
      setApproveTarget(null)
      loadRequests()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setApproving(false) }
  }

  async function handleRejectFromDialog() {
    if (!approveTarget) return
    setApproving(true)
    try {
      const res = await fetch(`/api/requests/${approveTarget.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REJECTED' }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Request rejected')
      setApproveTarget(null)
      loadRequests()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setApproving(false) }
  }

  // ── Strategic request actions
  async function handleSrApprove(sr: StrategicRequestApproval) {
    setSrActionLoad(sr.id + 'approve')
    try {
      const res = await fetch(`/api/strategic-requests/${sr.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Strategic request approved')
      loadStrategicRequests()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setSrActionLoad(null) }
  }

  async function handleSrReject() {
    if (!srRejectTarget) return
    setSrRejecting(true)
    try {
      const res = await fetch(`/api/strategic-requests/${srRejectTarget.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', note: srRejectNote }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Strategic request rejected')
      setSrRejectTarget(null)
      setSrRejectNote('')
      loadStrategicRequests()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setSrRejecting(false) }
  }

  const pendingCount    = wRequests.filter(r => r.status === 'SUBMITTED').length
  const inReviewCount   = wRequests.filter(r => r.status === 'REVIEW').length
  const pendingScCount  = changes.filter(c => c.status === 'PENDING').length
  const pendingSrCount  = srRequests.length

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Approvals</h1>
          <p className="text-muted-foreground text-sm">Review work requests and schedule changes</p>
        </div>
        {canApprove && (
          <Button onClick={() => setAssignDialogOpen(true)} size="sm" className="bg-blue-600 hover:bg-blue-700">
            <UserPlus className="mr-1.5 h-4 w-4" /> Assign Work
          </Button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b">
        <button
          onClick={() => setTab('requests')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'requests' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <ClipboardList className="h-4 w-4" />
          Work Requests
          {(pendingCount + inReviewCount) > 0 && (
            <span className="bg-orange-500 text-white text-xs rounded-full px-1.5 py-0.5 leading-none">
              {pendingCount + inReviewCount}
            </span>
          )}
        </button>
        {canApprove && (
          <button
            onClick={() => setTab('strategic')}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'strategic' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Target className="h-4 w-4" />
            Strategic Requests
            {pendingSrCount > 0 && (
              <span className="bg-orange-500 text-white text-xs rounded-full px-1.5 py-0.5 leading-none">
                {pendingSrCount}
              </span>
            )}
          </button>
        )}
        <button
          onClick={() => setTab('schedule')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'schedule' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <AlertTriangle className="h-4 w-4" />
          Schedule Changes
          {pendingScCount > 0 && (
            <span className="bg-orange-500 text-white text-xs rounded-full px-1.5 py-0.5 leading-none">
              {pendingScCount}
            </span>
          )}
        </button>
      </div>

      {/* ── WORK REQUESTS TAB ── */}
      {tab === 'requests' && (
        <div className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            {(['ALL_OPEN', 'SUBMITTED', 'REVIEW', 'APPROVED', 'REJECTED', 'CONVERTED'] as const).map((s) => (
              <button key={s} onClick={() => setWFilter(s)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  wFilter === s ? 'bg-foreground text-background border-foreground' : 'border-border hover:bg-muted'
                }`}>
                {s === 'ALL_OPEN' ? 'All Open' : s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>

          {wLoad ? (
            <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>
          ) : wRequests.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-muted-foreground">
              <ClipboardList className="h-10 w-10 opacity-20 mb-2" />
              <p className="text-sm">No requests to show</p>
            </div>
          ) : (
            <div className="space-y-3">
              {wRequests.map((req) => {
                const ia = inlineAssign[req.id] ?? { assigneeId: req.assignee?.id ?? '', estimatedHours: req.estimatedHours?.toString() ?? '' }
                const isDirty = ia.assigneeId !== (req.assignee?.id ?? '') || ia.estimatedHours !== (req.estimatedHours?.toString() ?? '')
                // Include current assignee in dropdown even if they're not in the active members list
                const selectMembers = (ia.assigneeId && ia.assigneeId !== 'none' && !teamMembers.some(m => m.id === ia.assigneeId) && req.assignee)
                  ? [...teamMembers, { id: req.assignee.id, name: req.assignee.name, role: '', capacityPct: 0 }]
                  : teamMembers
                return (
                <Card key={req.id} className={req.status === 'REJECTED' ? 'opacity-60' : ''}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-sm">{req.title}</h3>
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${REQ_STATUS_COLORS[req.status]}`}>
                            {req.status.charAt(0) + req.status.slice(1).toLowerCase()}
                          </span>
                          <Badge variant="outline" className="text-xs">{req.type}</Badge>
                          <Badge variant="secondary" className="text-xs">{req.priority}</Badge>
                          {req.estimatedHours && (
                            <Badge variant="outline" className="text-xs text-blue-600 border-blue-300">
                              <Clock className="mr-1 h-3 w-3" />{req.estimatedHours}h
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{req.description}</p>
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                          <span>By {req.submitter.name}</span>
                          <span>{format(new Date(req.createdAt), 'MMM d, yyyy')}</span>
                          {req.assignee && <span className="text-green-600">→ {req.assignee.name}</span>}
                          {req.project && <a href={`/projects/${req.project.id}`} className="text-blue-600 hover:underline">→ {req.project.name}</a>}
                        </div>
                      </div>

                      {canApprove && req.status !== 'CONVERTED' && req.status !== 'REJECTED' && req.status !== 'APPROVED' && (
                        <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
                          <Button size="sm" variant="outline"
                            className="h-7 text-xs text-green-600 border-green-200 hover:bg-green-50"
                            onClick={() => openApproveDialog(req)}>
                            <CheckCircle2 className="mr-1 h-3 w-3" /> Approve
                          </Button>
                          <Button size="sm" variant="outline"
                            className="h-7 text-xs text-red-600 border-red-200 hover:bg-red-50"
                            disabled={actionLoad === req.id + 'REJECTED'}
                            onClick={() => updateRequestStatus(req.id, 'REJECTED')}>
                            <XCircle className="mr-1 h-3 w-3" /> Reject
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* ── Inline assign + time estimate ── */}
                    {canApprove && req.status !== 'CONVERTED' && req.status !== 'REJECTED' && (
                      <div className="border-t pt-3 flex flex-wrap items-end gap-2">
                        <div className="flex-1 min-w-40 space-y-1">
                          <Label className="text-xs text-muted-foreground flex items-center gap-1">
                            <UserPlus className="h-3 w-3" /> Assign to
                          </Label>
                          <Select
                            value={ia.assigneeId || 'none'}
                            onValueChange={(v) => {
                              const s = v as string | null
                              setInlineAssign(prev => ({ ...prev, [req.id]: { ...ia, assigneeId: (!s || s === 'none') ? '' : s } }))
                            }}
                          >
                            <SelectTrigger className="h-7 text-xs">
                              <SelectValue placeholder="Unassigned">
                                {ia.assigneeId && ia.assigneeId !== 'none'
                                  ? (selectMembers.find(m => m.id === ia.assigneeId)?.name ?? '')
                                  : ''}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">— Unassigned —</SelectItem>
                              {selectMembers.map(m => (
                                <SelectItem key={m.id} value={m.id}>{m.name}
                                  {m.department ? ` · ${m.department}` : ''}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="w-28 space-y-1">
                          <Label className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" /> Est. Hours
                          </Label>
                          <Input className="h-7 text-xs" type="number" min="0" step="0.5" placeholder="e.g. 16"
                            value={ia.estimatedHours}
                            onChange={e => setInlineAssign(prev => ({ ...prev, [req.id]: { ...ia, estimatedHours: e.target.value } }))}
                          />
                        </div>
                        {isDirty && (
                          <Button size="sm" className="h-7 text-xs" disabled={savingAssign === req.id}
                            onClick={() => saveInlineAssign(req.id)}>
                            {savingAssign === req.id ? 'Saving…' : 'Save'}
                          </Button>
                        )}
                        {!isDirty && req.assignee && (
                          <p className="text-xs text-green-600">
                            Assigned to {req.assignee.name}{req.estimatedHours ? ` · ${req.estimatedHours}h` : ''}
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── STRATEGIC REQUESTS TAB ── */}
      {tab === 'strategic' && (
        <div className="space-y-4">
          {srLoad ? (
            <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)}</div>
          ) : srRequests.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-muted-foreground">
              <Target className="h-10 w-10 opacity-20 mb-2" />
              <p className="text-sm">No strategic requests pending approval</p>
            </div>
          ) : (
            <div className="space-y-3">
              {srRequests.map((sr) => (
                <Card key={sr.id}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-sm">{sr.title}</h3>
                          <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-yellow-100 text-yellow-700">
                            Pending Approval
                          </span>
                          {sr.tasks.length > 0 && (
                            <Badge variant="outline" className="text-xs">
                              {sr.tasks.length} task{sr.tasks.length !== 1 ? 's' : ''}
                            </Badge>
                          )}
                        </div>
                        {sr.description && (
                          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{sr.description}</p>
                        )}
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                          <span>By {sr.submitter.name}</span>
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {format(new Date(sr.startDate), 'MMM d, yyyy')}
                            {sr.endDate && <> → {format(new Date(sr.endDate), 'MMM d, yyyy')}</>}
                          </span>
                          <span>{format(new Date(sr.createdAt), 'MMM d, yyyy')}</span>
                        </div>
                        {sr.tasks.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {sr.tasks.slice(0, 4).map(t => (
                              <span key={t.id} className="text-xs bg-muted px-2 py-0.5 rounded-full">
                                {t.title}{t.assignee ? ` → ${t.assignee.name}` : ''}
                              </span>
                            ))}
                            {sr.tasks.length > 4 && (
                              <span className="text-xs text-muted-foreground">+{sr.tasks.length - 4} more</span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
                        <Button size="sm" variant="outline"
                          className="h-7 text-xs text-green-600 border-green-200 hover:bg-green-50"
                          disabled={srActionLoad === sr.id + 'approve'}
                          onClick={() => handleSrApprove(sr)}>
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          {srActionLoad === sr.id + 'approve' ? 'Approving…' : 'Approve'}
                        </Button>
                        <Button size="sm" variant="outline"
                          className="h-7 text-xs text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() => { setSrRejectTarget(sr); setSrRejectNote('') }}>
                          <XCircle className="mr-1 h-3 w-3" /> Reject
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── SCHEDULE CHANGES TAB ── */}
      {tab === 'schedule' && (
        <div className="space-y-4">
          <div className="flex gap-2">
            {(['PENDING', 'APPROVED', 'REJECTED'] as const).map((s) => (
              <Button key={s} variant={scFilter === s ? 'default' : 'outline'} size="sm"
                onClick={() => setScFilter(s)}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </Button>
            ))}
          </div>

          {changesLoad ? (
            <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-32 rounded-lg" />)}</div>
          ) : changes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <CheckCircle2 className="h-12 w-12 text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground">No {scFilter.toLowerCase()} changes</p>
            </div>
          ) : (
            <div className="space-y-3">
              {changes.map((change) => {
                const impact = change.impactSummary
                const isExpanded = expanded[change.id]
                return (
                  <Card key={change.id} className={change.status === 'REJECTED' ? 'opacity-70' : ''}>
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">
                          {change.status === 'PENDING'  && <Clock className="h-5 w-5 text-orange-500" />}
                          {change.status === 'APPROVED' && <CheckCircle2 className="h-5 w-5 text-green-500" />}
                          {change.status === 'REJECTED' && <XCircle className="h-5 w-5 text-red-500" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className="text-xs">
                              {CHANGE_TYPE_LABELS[change.changeType] || change.changeType}
                            </Badge>
                            {change.project && (
                              <span className="text-xs text-muted-foreground">{change.project.name}</span>
                            )}
                            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${SEVERITY_COLORS[impact?.severity] || 'text-muted-foreground'}`}>
                              {impact?.severity || 'UNKNOWN'} impact
                            </span>
                          </div>
                          <p className="text-sm font-medium mt-1">{change.description}</p>
                          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                            <span>By {change.requester.name}</span>
                            <span>{format(new Date(change.createdAt), 'MMM d, yyyy HH:mm')}</span>
                          </div>
                          {impact?.summary && (
                            <p className="text-xs text-muted-foreground mt-1.5 bg-muted/50 rounded px-2 py-1">
                              {impact.summary}
                            </p>
                          )}
                          {((impact?.affectedTasks?.length > 0) || (impact?.affectedProjects?.length > 0)) && (
                            <button className="text-xs text-muted-foreground mt-2 flex items-center gap-1 hover:text-foreground"
                              onClick={() => setExpanded((p) => ({ ...p, [change.id]: !p[change.id] }))}>
                              {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                              {isExpanded ? 'Hide' : 'Show'} impact details
                            </button>
                          )}
                          {isExpanded && (
                            <div className="mt-2 space-y-2 border-t pt-2">
                              {impact?.affectedTasks?.length > 0 && (
                                <div>
                                  <p className="text-xs font-medium mb-1">Affected Tasks</p>
                                  {impact.affectedTasks.map((t) => (
                                    <div key={t.id} className="text-xs text-muted-foreground flex items-center gap-1.5">
                                      <span>{t.name}</span>
                                      {t.delayDays && <Badge variant="destructive" className="text-[10px] px-1">+{t.delayDays}d</Badge>}
                                    </div>
                                  ))}
                                </div>
                              )}
                              {impact?.affectedProjects?.length > 0 && (
                                <div>
                                  <p className="text-xs font-medium mb-1">Affected Projects</p>
                                  {impact.affectedProjects.map((p) => (
                                    <div key={p.id} className="text-xs text-muted-foreground">{p.name}: {p.reason}</div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        {change.status === 'PENDING' && canApprove && (
                          <Button size="sm" onClick={() => setSelected(change)}>Review</Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Schedule Change Review Dialog ── */}
      <Dialog open={!!selected} onOpenChange={(v) => { if (!v) { setSelected(null); setComments(''); setAndonDelayDays('') } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Review Schedule Change</DialogTitle></DialogHeader>
          {selected && (
            <div className="space-y-4">
              <div className="p-3 bg-muted rounded-lg text-sm">
                <p className="font-medium">{selected.description}</p>
                <p className="text-muted-foreground text-xs mt-1">
                  Requested by {selected.requester.name} · {CHANGE_TYPE_LABELS[selected.changeType]}
                </p>
              </div>
              <div className={`p-3 rounded-lg text-sm ${SEVERITY_COLORS[selected.impactSummary?.severity] || 'bg-muted'}`}>
                <p className="font-medium flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4" />
                  {selected.impactSummary?.severity || 'UNKNOWN'} Impact
                </p>
                <p className="text-xs mt-1">{selected.impactSummary?.summary}</p>
              </div>
              {/* For RESOURCE_OVERLOAD: show which tasks will be delayed and by how much */}
              {selected.changeType === 'RESOURCE_OVERLOAD' && (() => {
                const proposed = selected.proposedData as Record<string, unknown>
                const tasks = proposed?.tasks as Array<{
                  taskId: string; name: string; priority: string
                  currentStartDate?: string; currentEndDate?: string
                  newStartDate?: string; newEndDate?: string
                }> | undefined
                if (!tasks?.length) return null
                return (
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">Tasks that will be delayed</p>
                    <div className="border rounded-md divide-y text-xs">
                      {tasks.map(t => (
                        <div key={t.taskId} className="px-3 py-2 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium flex-1 truncate">{t.name}</span>
                            <Badge variant="outline" className="text-[10px]">{t.priority}</Badge>
                          </div>
                          <div className="text-muted-foreground flex gap-3">
                            {t.currentEndDate && (
                              <span>Current end: {format(new Date(t.currentEndDate), 'MMM d')}</span>
                            )}
                            {t.newEndDate && (
                              <span className="text-orange-600 font-medium">
                                → New end: {format(new Date(t.newEndDate), 'MMM d')}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Approving will shift these tasks by {String(proposed.delayDays ?? '?')} working day(s).
                    </p>
                  </div>
                )
              })()}

              {/* For ANDON_RAISED: ask how many days delay before approving */}
              {selected?.changeType === 'ANDON_RAISED' && (
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">How many days will this delay the project? *</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      placeholder="e.g. 3"
                      value={andonDelayDays}
                      onChange={(e) => setAndonDelayDays(e.target.value)}
                      className="w-32"
                    />
                    <span className="text-sm text-muted-foreground">working days (enter 0 if no delay)</span>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Comments (optional)</label>
                <Textarea placeholder="Add a comment..." value={comments} onChange={(e) => setComments(e.target.value)} rows={3} />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => handleDecision(false)} disabled={processing}
              className="text-red-600 border-red-200 hover:bg-red-50">
              <XCircle className="mr-1.5 h-4 w-4" /> Reject
            </Button>
            <Button
              onClick={() => handleDecision(true)}
              disabled={processing || (selected?.changeType === 'ANDON_RAISED' && andonDelayDays === '')}
              className="bg-green-600 hover:bg-green-700">
              <CheckCircle2 className="mr-1.5 h-4 w-4" /> Approve & Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Approval Impact Dialog ── */}
      <Dialog open={!!approveTarget} onOpenChange={(v) => { if (!v) setApproveTarget(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" /> Review Request
            </DialogTitle>
          </DialogHeader>
          {approveTarget && (
            <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
              {/* Request summary */}
              <div className="p-3 bg-muted rounded-lg space-y-2">
                <p className="font-semibold text-sm">{approveTarget.title}</p>
                {approveTarget.description && (
                  <p className="text-xs text-muted-foreground">{approveTarget.description}</p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-xs">{approveTarget.type}</Badge>
                  <Badge variant="secondary" className="text-xs">{approveTarget.priority}</Badge>
                  {approveTarget.estimatedHours && (
                    <span className="text-xs text-blue-600 flex items-center gap-1">
                      <Clock className="h-3 w-3" />{approveTarget.estimatedHours}h estimated
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">by {approveTarget.submitter.name}</span>
                </div>
              </div>

              {/* Assignee schedule */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Assignee Schedule
                </p>
                {approveTarget.assignee ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">{approveTarget.assignee.name}</p>
                    {assigneeTasksLoading ? (
                      <div className="space-y-1.5">
                        <Skeleton className="h-5 rounded" />
                        <Skeleton className="h-5 rounded" />
                        <Skeleton className="h-5 rounded" />
                      </div>
                    ) : (() => {
                      const activeTasks = assigneeTasks.filter(t => !['COMPLETED', 'CANCELLED'].includes(t.status))
                      return activeTasks.length === 0 ? (
                        <p className="text-xs text-green-600">Schedule is clear — no active tasks.</p>
                      ) : (
                        <>
                          <div className="border rounded-md divide-y">
                            {activeTasks.slice(0, 6).map(t => (
                              <div key={t.id} className="flex items-center gap-2 text-xs px-3 py-2">
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  t.status === 'IN_PROGRESS' ? 'bg-yellow-500' :
                                  t.status === 'REVIEW' ? 'bg-purple-500' : 'bg-blue-400'
                                }`} />
                                <span className="flex-1 truncate font-medium">{t.name}</span>
                                <span className="text-muted-foreground shrink-0 truncate max-w-[100px]">
                                  {t.workstream?.project?.name}
                                </span>
                                {t.endDate && (
                                  <span className={`shrink-0 font-medium ${
                                    isPast(new Date(t.endDate)) ? 'text-red-500' : 'text-muted-foreground'
                                  }`}>
                                    {isPast(new Date(t.endDate)) ? '⚠ ' : ''}due {format(new Date(t.endDate), 'MMM d')}
                                  </span>
                                )}
                                {t.estimatedHours > 0 ? (
                                  <span className="text-blue-600 shrink-0 font-medium">{t.estimatedHours}h</span>
                                ) : t.effortHours > 0 ? (
                                  <span className="text-muted-foreground shrink-0">{t.effortHours}h</span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                          {activeTasks.length > 6 && (
                            <p className="text-xs text-muted-foreground">+{activeTasks.length - 6} more tasks</p>
                          )}
                          {approveTarget.estimatedHours && (
                            <div className="flex items-start gap-1.5 text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded p-2">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                              <span>
                                Adding <strong>{approveTarget.estimatedHours}h</strong> to {approveTarget.assignee.name}&apos;s workload
                                may delay {activeTasks.filter(t => t.endDate).length} tasks with deadlines.
                                Review their schedule above before approving.
                              </span>
                            </div>
                          )}
                        </>
                      )
                    })()}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    No assignee set — use the "Assign to" field on the request card to assign someone first.
                  </p>
                )}
              </div>

            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline"
              className="text-red-600 border-red-200 hover:bg-red-50"
              onClick={handleRejectFromDialog}
              disabled={approving}>
              <XCircle className="mr-1.5 h-4 w-4" /> Reject
            </Button>
            <Button variant="outline" onClick={() => setApproveTarget(null)} disabled={approving}>
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={handleApprove}
              disabled={approving}>
              {approving ? 'Processing…' : <><CheckCircle2 className="mr-1.5 h-4 w-4" /> Approve</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Direct Assign Work Dialog ── */}
      <AssignWorkDialog
        open={assignDialogOpen}
        onOpenChange={setAssignDialogOpen}
      />

      {/* ── Strategic Request Reject Dialog ── */}
      <Dialog open={!!srRejectTarget} onOpenChange={(v) => { if (!v) { setSrRejectTarget(null); setSrRejectNote('') } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" /> Reject Strategic Request
            </DialogTitle>
          </DialogHeader>
          {srRejectTarget && (
            <div className="space-y-4">
              <div className="p-3 bg-muted rounded-lg">
                <p className="font-semibold text-sm">{srRejectTarget.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">By {srRejectTarget.submitter.name}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Rejection note (optional)</Label>
                <Textarea
                  placeholder="Explain why this request is being rejected…"
                  value={srRejectNote}
                  onChange={(e) => setSrRejectNote(e.target.value)}
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setSrRejectTarget(null); setSrRejectNote('') }} disabled={srRejecting}>
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={handleSrReject}
              disabled={srRejecting}>
              {srRejecting ? 'Rejecting…' : <><XCircle className="mr-1.5 h-4 w-4" /> Confirm Reject</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
