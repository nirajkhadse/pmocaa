'use client'

import { useState, useCallback, useEffect } from 'react'
import { useAuthStore, canManageProjects } from '@/store/auth'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Plus, ChevronDown, ChevronRight, ChevronUp, History, Lock,
} from 'lucide-react'
import { format } from 'date-fns'
import { CreateTaskDialog } from './create-task-dialog'

interface OwnerHistoryEntry {
  id: string
  changedAt: string
  changedBy: { id: string; name: string }
  fromOwner?: { id: string; name: string } | null
  toOwner?: { id: string; name: string } | null
}

interface Task {
  id: string; name: string; description?: string; status: string; priority: string
  startDate?: string; endDate?: string
  actualStartDate?: string; actualEndDate?: string
  pctComplete?: number
  comments?: string
  effortHours: number; estimatedHours?: number
  owner?: { id: string; name: string; avatarUrl?: string }
}

interface Workstream {
  id: string; name: string; status: string; order: number
  lead?: { id: string; name: string }
  tasks: Task[]
}

interface Project {
  id: string; name: string
  leadId?: string
  planStatus?: string
  editAccessGranted?: boolean
  allocations: Array<{ userId: string; user: { id: string; name: string; role: string } }>
  workstreams: Workstream[]
}

const STATUS_COLORS: Record<string, string> = {
  BACKLOG: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  PLANNED: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  IN_PROGRESS: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  REVIEW: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  REWORK: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  COMPLETED: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
}

const PRIORITY_DOT: Record<string, string> = {
  LOW: 'bg-slate-400',
  MEDIUM: 'bg-blue-500',
  HIGH: 'bg-orange-500',
  CRITICAL: 'bg-red-500',
}

const TASK_STATUSES = ['BACKLOG', 'PLANNED', 'IN_PROGRESS', 'REVIEW', 'REWORK', 'COMPLETED', 'CANCELLED']

function DateRange({ start, end, muted }: { start?: string; end?: string; muted?: boolean }) {
  if (!start && !end) return null
  const fmt = (d: string) => format(new Date(d), 'MMM d')
  return (
    <span className={`text-xs font-medium tabular-nums ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>
      {start ? fmt(start) : '?'} – {end ? fmt(end) : '?'}
    </span>
  )
}

export function WorkstreamPanel({ project, onRefresh, productId, onlyDeliverables, hidePerProduct, onlyPerProduct }: { project: Project; onRefresh: () => void; productId?: string; onlyDeliverables?: boolean; hidePerProduct?: boolean; onlyPerProduct?: boolean }) {
  const { user } = useAuthStore()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  const [addingWs, setAddingWs] = useState(false)
  const [newWsName, setNewWsName] = useState('')
  const [createTaskWsId, setCreateTaskWsId] = useState<string | null>(null)
  const [ownerHistory, setOwnerHistory] = useState<Record<string, OwnerHistoryEntry[]>>({})
  const [showHistory, setShowHistory] = useState<Record<string, boolean>>({})
  const [taskEdits, setTaskEdits] = useState<Record<string, Partial<Task>>>({})
  const [savingTask, setSavingTask] = useState<string | null>(null)
  const [allUsers, setAllUsers] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setAllUsers(d) })
      .catch(() => {})
  }, [])

  const toggle = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }))
  const toggleTask = (id: string) => {
    setExpandedTask((prev) => (prev === id ? null : id))
    if (!taskEdits[id]) setTaskEdits((p) => ({ ...p, [id]: {} }))
  }

  const fetchOwnerHistory = useCallback(async (taskId: string) => {
    if (ownerHistory[taskId]) {
      setShowHistory((p) => ({ ...p, [taskId]: !p[taskId] }))
      return
    }
    try {
      const res = await fetch(`/api/tasks/${taskId}`)
      if (!res.ok) return
      const data = await res.json()
      setOwnerHistory((p) => ({ ...p, [taskId]: data.ownerHistory || [] }))
      setShowHistory((p) => ({ ...p, [taskId]: true }))
    } catch {
      toast.error('Failed to load history')
    }
  }, [ownerHistory])

  const isProjectLead = user?.role === 'PROJECT_LEAD' && user.id === project.leadId
  const canEdit =
    (user && canManageProjects(user.role)) ||
    (isProjectLead && project.planStatus !== 'APPROVED')
  // Timeline editing is the explicitly-granted capability from "Grant Edit Access" — independent
  // of plan status, unlike canEdit/canAssignTasks below.
  const canEditDates = !!(user && (
    ['ADMIN', 'MANAGER', 'PLANNER'].includes(user.role) ||
    (isProjectLead && project.editAccessGranted)
  ))
  const canAssignTasks = canEdit || (isProjectLead && project.planStatus !== 'APPROVED')

  function getEdit<K extends keyof Task>(task: Task, key: K): Task[K] {
    const edits = taskEdits[task.id]
    return (edits && key in edits ? edits[key] : task[key]) as Task[K]
  }

  function setEdit(taskId: string, key: keyof Task, value: unknown) {
    setTaskEdits((p) => ({ ...p, [taskId]: { ...p[taskId], [key]: value } }))
  }

  async function saveTask(task: Task) {
    const edits = taskEdits[task.id]
    if (!edits || Object.keys(edits).length === 0) return
    setSavingTask(task.id)
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      })
      if (!res.ok) throw new Error()
      toast.success('Task saved')
      setTaskEdits((p) => ({ ...p, [task.id]: {} }))
      onRefresh()
    } catch {
      toast.error('Failed to save task')
    } finally { setSavingTask(null) }
  }

  async function addWorkstream() {
    if (!newWsName.trim()) return
    try {
      const res = await fetch('/api/workstreams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newWsName.trim(), projectId: project.id }),
      })
      if (!res.ok) throw new Error()
      toast.success('Phase created')
      setNewWsName('')
      setAddingWs(false)
      onRefresh()
    } catch {
      toast.error('Failed to create phase')
    }
  }

  async function assignTask(taskId: string, ownerId: string | null) {
    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId: ownerId || null }),
      })
      onRefresh()
      if (ownerId) {
        const person = allUsers.find((u) => u.id === ownerId)
        if (person) {
          toast.success(`Assigned to ${person.name}`, {
            description: 'Task is now visible in their Kanban & Gantt views.',
            action: { label: 'View Kanban', onClick: () => window.open(`/kanban?owner=${ownerId}`, '_blank') },
          })
        }
      }
    } catch {
      toast.error('Failed to assign task')
    }
  }

  const now = new Date()

  // Workstreams shown in Report tab (onlyDeliverables); hidden from per-product Timeline.
  const CHECKLIST_WS = new Set(['Planning', 'Deliverables', 'Report', 'Reports & Report-out'])
  // Workstreams whose tasks are filtered per selected product (tagged __productTask:{productId}:)
  const PER_PRODUCT_WS = new Set(['Product Costing', 'BOB & A2Mac1', 'Tear Down', 'Costing'])

  // Filter a per-product workstream by productId, with fallback to all tasks for backward compat
  // (projects created before per-product tear-down/costing tasks were introduced)
  const filterByProduct = (ws: typeof project.workstreams[0], pid: string) => {
    const filtered = ws.tasks.filter((t) => t.description?.includes(`__productTask:${pid}:`))
    return { ...ws, tasks: filtered.length > 0 ? filtered : ws.tasks }
  }

  const visibleWorkstreams = onlyDeliverables
    ? project.workstreams.filter((ws) => CHECKLIST_WS.has(ws.name))
    : onlyPerProduct && productId
    ? project.workstreams
        .filter((ws) => PER_PRODUCT_WS.has(ws.name))
        .map((ws) => filterByProduct(ws, productId))
    : hidePerProduct
    ? project.workstreams.filter((ws) => !CHECKLIST_WS.has(ws.name) && !PER_PRODUCT_WS.has(ws.name))
    : productId
    ? project.workstreams
        .filter((ws) => !CHECKLIST_WS.has(ws.name))
        .map((ws) =>
          PER_PRODUCT_WS.has(ws.name)
            ? filterByProduct(ws, productId)
            : ws
        )
    : project.workstreams.filter((ws) => !CHECKLIST_WS.has(ws.name))

  return (
    <div className="space-y-3">
      {visibleWorkstreams.map((ws) => {
        const isOpen = expanded[ws.id] !== false
        const done = ws.tasks.filter((t) => t.status === 'COMPLETED').length
        const progress = ws.tasks.length ? Math.round((done / ws.tasks.length) * 100) : 0

        return (
          <Card key={ws.id} className="overflow-hidden">
            <CardHeader
              className="p-3 cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => toggle(ws.id)}
            >
              <div className="flex items-center gap-2">
                {isOpen
                  ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                }
                <CardTitle className="text-sm font-semibold flex-1">{ws.name}</CardTitle>
                {ws.lead && (
                  <span className="text-xs text-muted-foreground hidden sm:block">Lead: {ws.lead.name}</span>
                )}
                <Badge variant="secondary" className="text-xs">{done}/{ws.tasks.length}</Badge>
                <div className="w-20">
                  <Progress value={progress} className="h-1.5" />
                </div>
              </div>
            </CardHeader>

            {isOpen && (
              <CardContent className="p-0">
                <div className="divide-y divide-border">
                  {ws.tasks.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-4">No tasks</p>
                  ) : (
                    ws.tasks.map((task) => {
                      const isOverdue =
                        task.endDate &&
                        new Date(task.endDate) < now &&
                        !['COMPLETED', 'CANCELLED'].includes(task.status)
                      const isTaskExpanded = expandedTask === task.id
                      const pct = task.pctComplete ?? 0
                      const hasEdits = Object.keys(taskEdits[task.id] ?? {}).length > 0

                      return (
                        <div key={task.id}>
                          {/* ── Task row ── */}
                          <div
                            className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors cursor-pointer"
                            onClick={() => toggleTask(task.id)}
                          >
                            <div className={`h-2 w-2 rounded-full shrink-0 ${PRIORITY_DOT[task.priority]}`} />

                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium truncate block">{task.name}</span>
                            </div>

                            {/* Date range — prominent */}
                            <div className="hidden sm:flex items-center shrink-0">
                              {task.startDate || task.endDate
                                ? <DateRange start={task.startDate} end={task.endDate} />
                                : <span className="text-xs text-muted-foreground/50">No dates</span>
                              }
                            </div>

                            {/* Status + overdue */}
                            <div className="flex items-center gap-1 shrink-0">
                              <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[task.status]}`}>
                                {task.status.replace(/_/g, ' ')}
                              </span>
                              {isOverdue && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">Late</span>
                              )}
                              {pct > 0 && pct < 100 && (
                                <span className="text-xs text-muted-foreground">{pct}%</span>
                              )}
                            </div>

                            {/* Avatar / assign */}
                            <div onClick={(e) => e.stopPropagation()}>
                              {canAssignTasks ? (
                                <Select
                                  value={task.owner?.id || 'unassigned'}
                                  onValueChange={(v) => assignTask(task.id, v === 'unassigned' ? null : v)}
                                >
                                  <SelectTrigger className="h-7 w-auto min-w-0 border-0 bg-transparent p-0 shadow-none focus:ring-0">
                                    <Avatar className="h-6 w-6 cursor-pointer">
                                      <AvatarFallback className="text-xs">
                                        {task.owner
                                          ? task.owner.name.split(' ').map((n) => n[0]).join('').slice(0, 2)
                                          : '?'}
                                      </AvatarFallback>
                                    </Avatar>
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="unassigned">Unassigned</SelectItem>
                                    {allUsers.map((u) => (
                                      <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ) : task.owner ? (
                                <Avatar className="h-6 w-6 shrink-0">
                                  <AvatarFallback className="text-xs">
                                    {task.owner.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                                  </AvatarFallback>
                                </Avatar>
                              ) : null}
                            </div>

                            {isTaskExpanded
                              ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            }
                          </div>

                          {/* ── Expanded task edit ── */}
                          {isTaskExpanded && (
                            <div className="bg-muted/20 px-4 pb-3 pt-3 space-y-3 border-t border-border/50">

                              {/* Status row */}
                              <div className="grid grid-cols-3 gap-2">
                                <div className="col-span-2 space-y-1">
                                  <Label className="text-xs text-muted-foreground">Status</Label>
                                  <Select
                                    value={getEdit(task, 'status') as string}
                                    onValueChange={(v) => setEdit(task.id, 'status', v ?? task.status)}
                                  >
                                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      {TASK_STATUSES.map((s) => (
                                        <SelectItem key={s} value={s}>{s.replace(/_/g, ' ')}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs text-muted-foreground">% Done</Label>
                                  <Input
                                    type="number" min={0} max={100}
                                    value={getEdit(task, 'pctComplete') as number ?? 0}
                                    onChange={(e) => setEdit(task.id, 'pctComplete', Number(e.target.value))}
                                    className="h-7 text-xs"
                                  />
                                </div>
                              </div>

                              {/* Scheduled dates */}
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Scheduled</span>
                                  {!canEditDates && <Lock className="h-3 w-3 text-muted-foreground/50" />}
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Start</Label>
                                    <Input
                                      type="date"
                                      value={(getEdit(task, 'startDate') as string)?.slice(0, 10) ?? ''}
                                      onChange={(e) => setEdit(task.id, 'startDate', e.target.value)}
                                      disabled={!canEditDates}
                                      className="h-7 text-xs px-2"
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">End</Label>
                                    <Input
                                      type="date"
                                      value={(getEdit(task, 'endDate') as string)?.slice(0, 10) ?? ''}
                                      onChange={(e) => setEdit(task.id, 'endDate', e.target.value)}
                                      disabled={!canEditDates}
                                      className="h-7 text-xs px-2"
                                    />
                                  </div>
                                </div>
                              </div>

                              {/* Actual dates */}
                              <div className="space-y-1.5">
                                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Actual</span>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Start</Label>
                                    <Input
                                      type="date"
                                      value={(getEdit(task, 'actualStartDate') as string)?.slice(0, 10) ?? ''}
                                      onChange={(e) => setEdit(task.id, 'actualStartDate', e.target.value)}
                                      disabled={!(canEditDates || task.owner?.id === user?.id)}
                                      className="h-7 text-xs px-2"
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">End</Label>
                                    <Input
                                      type="date"
                                      value={(getEdit(task, 'actualEndDate') as string)?.slice(0, 10) ?? ''}
                                      onChange={(e) => setEdit(task.id, 'actualEndDate', e.target.value)}
                                      disabled={!(canEditDates || task.owner?.id === user?.id)}
                                      className="h-7 text-xs px-2"
                                    />
                                  </div>
                                </div>
                              </div>

                              {/* Comments */}
                              <div className="space-y-1">
                                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Comments</Label>
                                <Textarea
                                  placeholder="Add a comment or note…"
                                  rows={3}
                                  value={(getEdit(task, 'comments') as string) ?? task.comments ?? ''}
                                  onChange={(e) => setEdit(task.id, 'comments', e.target.value)}
                                  className="text-xs resize-none"
                                />
                              </div>

                              <div className="flex items-center justify-between pt-0.5">
                                <Button
                                  type="button" variant="ghost" size="sm"
                                  className="h-7 text-xs text-muted-foreground"
                                  onClick={() => fetchOwnerHistory(task.id)}
                                >
                                  <History className="mr-1 h-3.5 w-3.5" />
                                  {showHistory[task.id] ? 'Hide' : 'Show'} History
                                </Button>
                                <Button
                                  size="sm" className="h-7 text-xs"
                                  disabled={!hasEdits || savingTask === task.id}
                                  onClick={() => saveTask(task)}
                                >
                                  {savingTask === task.id ? 'Saving…' : 'Save'}
                                </Button>
                              </div>

                              {showHistory[task.id] && (
                                <div className="rounded border border-border/60 bg-background p-2 space-y-1">
                                  {(ownerHistory[task.id] || []).length === 0 ? (
                                    <p className="text-xs text-muted-foreground text-center py-1">No assignment changes yet</p>
                                  ) : (
                                    (ownerHistory[task.id] || []).map((h) => (
                                      <div key={h.id} className="flex items-center gap-2 text-xs flex-wrap">
                                        <span className="text-muted-foreground shrink-0">
                                          {format(new Date(h.changedAt), 'MMM d, HH:mm')}
                                        </span>
                                        <span className="font-medium">{h.changedBy.name}</span>
                                        <span className="text-muted-foreground">changed:</span>
                                        <span className="font-medium">{h.fromOwner?.name || 'Unassigned'}</span>
                                        <span className="text-muted-foreground">→</span>
                                        <span className="font-medium">{h.toOwner?.name || 'Unassigned'}</span>
                                      </div>
                                    ))
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>

                {canEdit && (
                  <div className="p-3 border-t border-border">
                    <Button
                      variant="ghost" size="sm" className="h-7 text-xs"
                      onClick={() => setCreateTaskWsId(ws.id)}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add Task
                    </Button>
                  </div>
                )}
              </CardContent>
            )}
          </Card>
        )
      })}

      {canEdit && (
        <div>
          {addingWs ? (
            <div className="flex gap-2">
              <Input
                placeholder="Phase name..."
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addWorkstream(); if (e.key === 'Escape') setAddingWs(false) }}
                autoFocus
                className="h-8 text-sm"
              />
              <Button size="sm" className="h-8" onClick={addWorkstream}>Add</Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setAddingWs(false)}>Cancel</Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setAddingWs(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add Phase
            </Button>
          )}
        </div>
      )}

      {createTaskWsId && (
        <CreateTaskDialog
          open={!!createTaskWsId}
          onOpenChange={(v) => { if (!v) setCreateTaskWsId(null) }}
          workstreamId={createTaskWsId}
          onCreated={onRefresh}
          allowedUsers={isProjectLead ? project.allocations.map((a) => a.user) : undefined}
        />
      )}
    </div>
  )
}
