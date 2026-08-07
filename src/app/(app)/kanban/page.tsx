'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Calendar, Clock, GripVertical, User2, Briefcase, RotateCcw, History } from 'lucide-react'
import { format } from 'date-fns'
import { useAuthStore } from '@/store/auth'

interface HistoryEntry {
  id: string
  fromStatus?: string
  toStatus: string
  changedAt: string
  durationMinutes?: number
  note?: string
  changedBy?: { id: string; name: string }
}

interface FullTask {
  id: string
  name: string
  description?: string
  status: string
  priority: string
  startDate?: string
  endDate?: string
  effortHours: number
  estimatedHours: number
  reworkCount: number
  statusChangedAt: string
  ownerId?: string
  assignedById?: string
  owner?: { id: string; name: string; avatarUrl?: string; email?: string; role?: string }
  assignedBy?: { id: string; name: string; avatarUrl?: string; role?: string }
  approvedBy?: { id: string; name: string; avatarUrl?: string; role?: string }
  workstream: { id: string; name: string; project: { id: string; name: string; leadId?: string | null } }
  history: HistoryEntry[]
}

interface UserOption {
  id: string
  name: string
  role: string
  avatarUrl?: string
  isActive?: boolean
}

interface Task {
  id: string
  name: string
  status: string
  priority: string
  startDate?: string
  endDate?: string
  effortHours: number
  estimatedHours: number
  order: number
  ownerId?: string
  assignedById?: string
  reworkCount: number
  statusChangedAt: string
  owner?: { id: string; name: string; avatarUrl?: string }
  workstream: { id: string; name: string; project: { id: string; name: string } }
  _isStrategic?: boolean
  _srId?: string
  _submitterName?: string | null
  _submitterId?: string | null
}

interface Project { id: string; name: string }

const COLUMNS = [
  { id: 'BACKLOG',     label: 'Backlog',      color: 'bg-slate-100 dark:bg-slate-800' },
  { id: 'PLANNED',    label: 'Planned',       color: 'bg-blue-50 dark:bg-blue-950' },
  { id: 'IN_PROGRESS',label: 'In Progress',   color: 'bg-yellow-50 dark:bg-yellow-950' },
  { id: 'REVIEW',     label: 'Review',        color: 'bg-purple-50 dark:bg-purple-950' },
  { id: 'REWORK',     label: 'Rework',        color: 'bg-red-50 dark:bg-red-950' },
  { id: 'COMPLETED',  label: 'Completed',     color: 'bg-green-50 dark:bg-green-950' },
]

const PRIORITY_COLORS: Record<string, string> = {
  LOW: 'border-l-slate-300', MEDIUM: 'border-l-blue-400',
  HIGH: 'border-l-orange-400', CRITICAL: 'border-l-red-500',
}

const PRIORITY_BADGE: Record<string, string> = {
  LOW: 'bg-slate-100 text-slate-600', MEDIUM: 'bg-blue-100 text-blue-700',
  HIGH: 'bg-orange-100 text-orange-700', CRITICAL: 'bg-red-100 text-red-700',
}

const REVIEWER_ROLES = new Set(['ADMIN', 'MANAGER', 'PLANNER', 'PROJECT_LEAD', 'WORKSTREAM_LEAD'])

function timeInStatus(statusChangedAt: string): string {
  const diffMs = Date.now() - new Date(statusChangedAt).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 2) return 'just now'
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d`
}

export default function KanbanPage() {
  const { user } = useAuthStore()
  const searchParams = useSearchParams()
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [projectFilter, setProjectFilter] = useState<string | null>('ALL')
  const [ownerFilter, setOwnerFilter] = useState<string | null>(searchParams.get('owner') ?? 'ME')
  const [completedDateFilter, setCompletedDateFilter] = useState('')
  const [allUsers, setAllUsers] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setAllUsers(d) })
      .catch(() => {})
  }, [])

  // Rework dialog state
  const [reworkOpen, setReworkOpen] = useState(false)
  const [reworkTarget, setReworkTarget] = useState<Task | null>(null)
  const [reworkNote, setReworkNote] = useState('')
  const [reworkLoading, setReworkLoading] = useState(false)

  // Submit-for-review dialog state
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewTarget, setReviewTarget] = useState<Task | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  const [reviewLoading, setReviewLoading] = useState(false)

  // Task detail dialog state
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailFull, setDetailFull] = useState<FullTask | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [userOptions, setUserOptions] = useState<UserOption[]>([])
  const [editAssigneeId, setEditAssigneeId] = useState<string | null>(null)
  const [savingAssignee, setSavingAssignee] = useState(false)

  // Strategic task detail (simple read-only view)
  const [strategicDetailTask, setStrategicDetailTask] = useState<Task | null>(null)

  // Reassignment is normal project-lead housekeeping, independent of the "Grant Edit Access"
  // timeline feature — matches canAssign in api/tasks/[id]/route.ts.
  const canEditAssignee = !!(user && (
    ['ADMIN', 'MANAGER', 'PLANNER'].includes(user.role) ||
    (user.role === 'PROJECT_LEAD' && detailFull?.workstream?.project?.leadId === user.id)
  ))

  // Use a ref for load so the interval doesn't capture stale closures
  const loadRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const loadInFlightRef = useRef(false)

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return
    loadInFlightRef.current = true
    try {
      const requestOptions: RequestInit = {
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      }
      const [taskRes, projRes, srRes] = await Promise.all([
        fetch('/api/tasks', requestOptions),
        fetch('/api/projects', requestOptions),
        fetch('/api/strategic-tasks', requestOptions),
      ])
      const [taskData, projData, srData] = await Promise.all([taskRes.json(), projRes.json(), srRes.json()])
      const allTasks = [
        ...(Array.isArray(taskData) ? taskData : []),
        ...(Array.isArray(srData) ? srData : []),
      ]
      setTasks(allTasks)
      setProjects(Array.isArray(projData) ? projData : [])
    } finally {
      loadInFlightRef.current = false
      setLoading(false)
    }
  }, [])

  loadRef.current = load

  useEffect(() => {
    load()
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') loadRef.current?.()
    }, 15000)
    return () => clearInterval(interval)
  }, [load])

  // Immediately refresh when the user switches back to this tab
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadRef.current?.()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Immediately refresh when a request is deleted on another tab/page
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'tasks-invalidated') loadRef.current?.()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const filteredTasks = tasks.filter((t) => {
    if (projectFilter && projectFilter !== 'ALL' && t.workstream.project.id !== projectFilter) return false
    // "My Tasks" includes work owned by the user and work they assigned.
    // Assigned work must stay visible when its owner submits it for review so
    // the assigner can approve it or request rework.
    if (ownerFilter === 'ME' && t.owner?.id !== user?.id && t.assignedById !== user?.id) return false
    if (ownerFilter === 'UNASSIGNED' && t.owner) return false
    if (ownerFilter && !['ALL', 'ME', 'UNASSIGNED'].includes(ownerFilter) && t.owner?.id !== ownerFilter) return false
    return true
  })

  const getColumnTasks = (status: string) =>
    filteredTasks
      .filter((t) => {
        if (t.status !== status) return false
        if (status === 'COMPLETED' && completedDateFilter) {
          return format(new Date(t.statusChangedAt), 'yyyy-MM-dd') === completedDateFilter
        }
        return true
      })
      .sort((a, b) => a.order - b.order)

  async function patchStatus(taskId: string, status: string, extra?: Record<string, unknown>) {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, ...extra }),
    })
    if (!res.ok) throw new Error('Failed to update task')
    await load()
  }

  // Horizontal auto-scroll while dragging a card near the board's left/right edge —
  // only 4 of 6 columns fit on screen at once, so this reveals Rework/Completed while dragging.
  // Driven by setInterval rather than requestAnimationFrame: rAF callbacks are fully suspended
  // by the browser whenever it considers the tab non-visible, which made the scroll silently
  // stop firing in some environments even though pointer tracking kept working fine.
  const boardScrollRef = useRef<HTMLDivElement>(null)
  const pointerXRef = useRef<number | null>(null)
  const pointerYRef = useRef<number | null>(null)
  const autoScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const AUTO_SCROLL_EDGE = 140
  const AUTO_SCROLL_MIN_SPEED = 14
  const AUTO_SCROLL_MAX_SPEED = 55
  const AUTO_SCROLL_TICK_MS = 16

  const handleDragPointerMove = useCallback((e: MouseEvent) => {
    pointerXRef.current = e.clientX
    pointerYRef.current = e.clientY
  }, [])

  const runAutoScroll = useCallback(() => {
    const container = boardScrollRef.current
    const x = pointerXRef.current
    const y = pointerYRef.current
    if (!container || x === null || y === null) return
    const rect = container.getBoundingClientRect()
    if (y < rect.top || y > rect.bottom) return
    const distFromLeft = x - rect.left
    const distFromRight = rect.right - x
    // Speed ramps from MIN (at the outer edge of the zone) to MAX (right at the border) —
    // a floor speed keeps it feeling responsive as soon as you cross into the zone.
    if (distFromLeft >= 0 && distFromLeft < AUTO_SCROLL_EDGE) {
      const ratio = 1 - distFromLeft / AUTO_SCROLL_EDGE
      container.scrollLeft -= AUTO_SCROLL_MIN_SPEED + (AUTO_SCROLL_MAX_SPEED - AUTO_SCROLL_MIN_SPEED) * ratio
    } else if (distFromRight >= 0 && distFromRight < AUTO_SCROLL_EDGE) {
      const ratio = 1 - distFromRight / AUTO_SCROLL_EDGE
      container.scrollLeft += AUTO_SCROLL_MIN_SPEED + (AUTO_SCROLL_MAX_SPEED - AUTO_SCROLL_MIN_SPEED) * ratio
    }
  }, [])

  const stopAutoScroll = useCallback(() => {
    window.removeEventListener('mousemove', handleDragPointerMove)
    if (autoScrollTimerRef.current !== null) {
      clearInterval(autoScrollTimerRef.current)
      autoScrollTimerRef.current = null
    }
    pointerXRef.current = null
    pointerYRef.current = null
  }, [handleDragPointerMove])

  const onDragStart = useCallback(() => {
    window.addEventListener('mousemove', handleDragPointerMove)
    autoScrollTimerRef.current = setInterval(runAutoScroll, AUTO_SCROLL_TICK_MS)
  }, [handleDragPointerMove, runAutoScroll])

  useEffect(() => stopAutoScroll, [stopAutoScroll])

  async function onDragEnd(result: DropResult) {
    stopAutoScroll()
    if (!result.destination) return
    const { draggableId, destination } = result
    const newStatus = destination.droppableId
    const task = tasks.find((t) => t.id === draggableId)
    if (!task || task.status === newStatus) return

    // Guard: prevent task owners from bypassing review when someone ELSE assigned the task to them.
    // Exceptions allowed:
    //   1. Self-assigned: assignedById is null or equals ownerId — the person did the work AND
    //      requested it themselves, so no separate reviewer is needed.
    //   2. Reviewers (PROJECT_LEAD / MANAGER etc.) dragging a REVIEW-status task to COMPLETED.
    if (!task._isStrategic && newStatus === 'COMPLETED') {
      const isOwner = task.ownerId === user?.id
      // Self-assigned = no external assigner, or the assigner is the owner themselves
      const isSelfAssigned = isOwner && (!task.assignedById || task.assignedById === task.ownerId)
      const isFromReview = task.status === 'REVIEW'
      const isReviewer = !isOwner && canReview(task)

      if (!isSelfAssigned) {
        if (isOwner) {
          // Task was assigned by someone else — must go through the review flow
          toast.error('Submit this task for review first — your reviewer will mark it complete.')
          return
        }
        if (!isReviewer) {
          toast.error('Only the task assigner, project lead, or a manager can mark this task complete.')
          return
        }
        if (!isFromReview) {
          toast.error('The task must be in Review status before it can be marked complete.')
          return
        }
      }
    }

    // Optimistic update
    setTasks((prev) =>
      prev.map((t) => (t.id === draggableId ? { ...t, status: newStatus } : t))
    )

    try {
      let res: Response
      if (task._isStrategic && task._srId) {
        res = await fetch(`/api/strategic-requests/${task._srId}/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus }),
        })
      } else {
        res = await fetch(`/api/tasks/${draggableId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus, order: destination.index }),
        })
      }
      if (!res.ok) throw new Error()
      await load()
    } catch {
      // Revert on error
      setTasks((prev) =>
        prev.map((t) => (t.id === draggableId ? { ...t, status: task.status } : t))
      )
      toast.error('Failed to update task status')
    }
  }

  async function openDetail(task: Task) {
    if (task._isStrategic) {
      setStrategicDetailTask(task)
      return
    }
    setDetailFull(null)
    setDetailLoading(true)
    setDetailOpen(true)
    try {
      const fetches: Promise<Response>[] = [fetch(`/api/tasks/${task.id}`)]
      if (canEditAssignee) fetches.push(fetch('/api/users'))
      const [taskRes, usersRes] = await Promise.all(fetches)
      const full: FullTask = await taskRes.json()
      setDetailFull(full)
      setEditAssigneeId(full.ownerId ?? null)
      if (usersRes) {
        const ud = await usersRes.json()
        setUserOptions(Array.isArray(ud) ? ud : [])
      }
    } finally {
      setDetailLoading(false)
    }
  }

  async function saveAssignee() {
    if (!detailFull) return
    setSavingAssignee(true)
    try {
      const res = await fetch(`/api/tasks/${detailFull.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId: editAssigneeId }),
      })
      if (!res.ok) throw new Error()
      toast.success('Assignee updated')
      setDetailOpen(false)
      await load()
    } catch {
      toast.error('Failed to update assignee')
    } finally {
      setSavingAssignee(false)
    }
  }

  function openReviewDialog(task: Task) {
    setReviewTarget(task)
    setReviewNote('')
    setReviewOpen(true)
  }

  async function submitReview() {
    if (!reviewTarget || !reviewNote.trim()) return
    setReviewLoading(true)
    try {
      await patchStatus(reviewTarget.id, 'REVIEW', { reviewNote: reviewNote.trim() })
      setReviewOpen(false)
      setReviewTarget(null)
      toast.success('Task submitted for review')
    } catch {
      toast.error('Failed to submit task for review')
    } finally {
      setReviewLoading(false)
    }
  }

  function openReworkDialog(task: Task) {
    setReworkTarget(task)
    setReworkNote('')
    setReworkOpen(true)
  }

  async function submitRework() {
    if (!reworkTarget) return
    setReworkLoading(true)
    try {
      await patchStatus(reworkTarget.id, 'REWORK', { reworkNote: reworkNote || undefined })
      setReworkOpen(false)
      setReworkTarget(null)
      toast.success('Task sent back for rework')
    } catch {
      toast.error('Failed to send task for rework')
    } finally {
      setReworkLoading(false)
    }
  }

  const canReview = (task: Task) => {
    if (!user) return false
    // The person the task is assigned to can never approve/reject their own task,
    // regardless of role — review rights belong to the assigner, PLANNER, or MANAGER.
    if (task.ownerId === user.id) return false
    return task.assignedById === user.id || REVIEWER_ROLES.has(user.role)
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-5 shrink-0">
        <div>
          <h1 className="text-2xl font-bold">Kanban Board</h1>
          <p className="text-muted-foreground text-sm">{filteredTasks.length} tasks</p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="w-44 h-8 text-sm">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {user?.role !== 'RESOURCE' && (
            <Select value={ownerFilter ?? 'ALL'} onValueChange={setOwnerFilter}>
              <SelectTrigger className="w-44 h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Assignees</SelectItem>
                <SelectItem value="ME">My Tasks</SelectItem>
                <SelectItem value="UNASSIGNED">Unassigned</SelectItem>
                {allUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-1.5">
            <label htmlFor="completed-date-filter" className="text-xs text-muted-foreground whitespace-nowrap">
              Completed on
            </label>
            <Input
              id="completed-date-filter"
              type="date"
              value={completedDateFilter}
              onChange={(e) => setCompletedDateFilter(e.target.value)}
              className="h-8 w-[145px] text-xs"
              aria-label="Filter completed tasks by completion date"
            />
            {completedDateFilter && (
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setCompletedDateFilter('')}>
                Clear
              </Button>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {COLUMNS.map((col) => (
            <div key={col.id} className="w-72 shrink-0 space-y-3">
              <Skeleton className="h-8 rounded" />
              {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded" />)}
            </div>
          ))}
        </div>
      ) : (
        <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div ref={boardScrollRef} className="flex gap-4 overflow-x-auto pb-4 flex-1 min-h-0">
            {COLUMNS.map((col) => {
              const colTasks = getColumnTasks(col.id)
              return (
                <div key={col.id} className="w-72 shrink-0 flex flex-col">
                  <div className={`rounded-t-lg px-3 py-2 ${col.color} flex items-center justify-between`}>
                    <span className="text-sm font-semibold">{col.label}</span>
                    <Badge variant="secondary" className="text-xs">{colTasks.length}</Badge>
                  </div>
                  <Droppable droppableId={col.id}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                        className={`flex-1 min-h-24 overflow-y-auto rounded-b-lg p-2 space-y-2 transition-colors ${
                          snapshot.isDraggingOver ? 'bg-muted/60 ring-1 ring-primary/20' : 'bg-muted/30'
                        }`}
                      >
                        {colTasks.map((task, index) => (
                          <Draggable key={task.id} draggableId={task.id} index={index}>
                            {(drag, dragSnapshot) => (
                              <div
                                ref={drag.innerRef}
                                {...drag.draggableProps}
                                className={`bg-card rounded-lg border border-border border-l-4 ${
                                  task._isStrategic ? 'border-l-purple-400' : PRIORITY_COLORS[task.priority]
                                } p-3 shadow-sm hover:shadow-md transition-shadow cursor-pointer ${dragSnapshot.isDragging ? 'shadow-lg rotate-1' : ''}`}
                                onClick={() => openDetail(task)}
                              >
                                <div className="flex items-start gap-2">
                                  <div
                                    {...drag.dragHandleProps}
                                    className="mt-0.5 text-muted-foreground"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <GripVertical className="h-3.5 w-3.5" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-start gap-1">
                                      {task._isStrategic && (
                                        <span className="text-[10px] font-semibold text-purple-600 dark:text-purple-400 shrink-0 mt-0.5">★</span>
                                      )}
                                      <p className="text-sm font-medium leading-tight line-clamp-2">{task.name}</p>
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                      {task._isStrategic
                                        ? task.workstream.name
                                        : task.workstream.project.name === '__direct_assignments__'
                                          ? 'Direct Assignment'
                                          : `${task.workstream.project.name} · ${task.workstream.name}`}
                                    </p>
                                    {!task._isStrategic && (
                                      <div className="flex items-center gap-1.5 mt-0.5">
                                        <span className="text-[10px] text-muted-foreground/70">
                                          · {timeInStatus(task.statusChangedAt)} in status
                                        </span>
                                        {task.reworkCount > 0 && (
                                          <span className="text-[10px] bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 px-1 rounded">
                                            ↩ {task.reworkCount}
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>

                                <div className="mt-2 flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-1.5">
                                    {task._isStrategic ? (
                                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                                        Strategic
                                      </span>
                                    ) : (
                                      <span className={`text-xs px-1.5 py-0.5 rounded ${PRIORITY_BADGE[task.priority]}`}>
                                        {task.priority}
                                      </span>
                                    )}
                                    {task.estimatedHours > 0 && (
                                      <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                                        <Clock className="h-3 w-3" />{task.estimatedHours}h
                                      </span>
                                    )}
                                  </div>
                                  {task.owner ? (
                                    <Avatar className="h-5 w-5" title={task.owner.name}>
                                      <AvatarFallback className="text-[10px]">
                                        {task.owner.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                                      </AvatarFallback>
                                    </Avatar>
                                  ) : (
                                    <span className="text-xs text-muted-foreground/50">Unassigned</span>
                                  )}
                                </div>

                                {task.endDate && (
                                  <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                                    <Calendar className="h-3 w-3" />
                                    <span>Due {format(new Date(task.endDate), 'MMM d')}</span>
                                  </div>
                                )}

                                {/* Early / late badge — only on completed non-strategic tasks */}
                                {task.status === 'COMPLETED' && (
                                  <div className="mt-1.5 flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400">
                                    <Calendar className="h-3 w-3" />
                                    <span>Completed {format(new Date(task.statusChangedAt), 'MMM d, yyyy')}</span>
                                  </div>
                                )}

                                {task.status === 'COMPLETED' && !task._isStrategic && task.endDate && (() => {
                                  const diffDays = Math.round(
                                    (new Date(task.statusChangedAt).getTime() - new Date(task.endDate).getTime())
                                    / (24 * 60 * 60 * 1000)
                                  )
                                  if (diffDays === 0) return null
                                  return (
                                    <div className={`mt-1 text-[10px] px-1.5 py-0.5 rounded font-medium inline-block ${
                                      diffDays < 0
                                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                        : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                    }`}>
                                      {diffDays < 0 ? `✓ ${Math.abs(diffDays)}d early` : `⚠ ${diffDays}d late`}
                                    </div>
                                  )
                                })()}

                                {/* Action buttons — only for regular (non-strategic) tasks */}
                                {!task._isStrategic && task.status === 'IN_PROGRESS' && task.ownerId === user?.id && (
                                  <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-6 text-xs w-full text-green-700 border-green-400 hover:bg-green-50 dark:text-green-400 dark:border-green-700 dark:hover:bg-green-950"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        openReviewDialog(task)
                                      }}
                                    >
                                      Submit for Review
                                    </Button>
                                  </div>
                                )}

                                {!task._isStrategic && task.status === 'REVIEW' && canReview(task) && (
                                  <div className="mt-2 flex gap-1" onClick={(e) => e.stopPropagation()}>
                                    <Button
                                      size="sm"
                                      className="h-6 text-xs flex-1 bg-green-600 hover:bg-green-700 text-white"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        patchStatus(task.id, 'COMPLETED').catch(() =>
                                          toast.error('Failed to approve task')
                                        )
                                      }}
                                    >
                                      ✓ Approve
                                    </Button>
                                    <Button
                                      size="sm"
                                      className="h-6 text-xs flex-1 bg-orange-500 hover:bg-orange-600 text-white"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        openReworkDialog(task)
                                      }}
                                    >
                                      ↩ Rework
                                    </Button>
                                  </div>
                                )}

                                {!task._isStrategic && task.status === 'REWORK' && task.ownerId === user?.id && (
                                  <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-6 text-xs w-full text-orange-700 border-orange-400 hover:bg-orange-50 dark:text-orange-400 dark:border-orange-700 dark:hover:bg-orange-950"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        patchStatus(task.id, 'IN_PROGRESS').catch(() =>
                                          toast.error('Failed to move task back to work')
                                        )
                                      }}
                                    >
                                      ↩ Back to Work
                                    </Button>
                                  </div>
                                )}
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                        {colTasks.length === 0 && !snapshot.isDraggingOver && (
                          <p className="text-center text-xs text-muted-foreground/50 py-4">Drop here</p>
                        )}
                      </div>
                    )}
                  </Droppable>
                </div>
              )
            })}
          </div>
        </DragDropContext>
      )}

      {/* ── Task Detail Dialog ─────────────────────────────────────── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="pr-6 leading-snug">
              {detailFull ? detailFull.name : 'Loading…'}
            </DialogTitle>
          </DialogHeader>

          {detailLoading && (
            <div className="space-y-3 py-4">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-5 rounded" />)}
            </div>
          )}

          {detailFull && !detailLoading && (() => {
            const STATUS_COLORS_MAP: Record<string, string> = {
              BACKLOG: 'bg-slate-100 text-slate-700', PLANNED: 'bg-blue-100 text-blue-700',
              IN_PROGRESS: 'bg-yellow-100 text-yellow-800', REVIEW: 'bg-purple-100 text-purple-700',
              REWORK: 'bg-red-100 text-red-700', COMPLETED: 'bg-green-100 text-green-700',
              CANCELLED: 'bg-gray-100 text-gray-500',
            }
            const STATUS_LABELS: Record<string, string> = {
              BACKLOG: 'Backlog', PLANNED: 'Planned', IN_PROGRESS: 'In Progress',
              REVIEW: 'Review', REWORK: 'Rework', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
            }
            const formatDur = (min?: number) => {
              if (!min) return ''
              if (min < 60) return `${min}m`
              const h = Math.floor(min / 60)
              return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
            }
            const assigneeChanged = editAssigneeId !== (detailFull.ownerId ?? null)
            return (
              <div className="space-y-5 py-1">
                {/* Status + Priority */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS_MAP[detailFull.status]}`}>
                    {STATUS_LABELS[detailFull.status]}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${PRIORITY_BADGE[detailFull.priority]}`}>
                    {detailFull.priority}
                  </span>
                  {detailFull.reworkCount > 0 && (
                    <span className="text-xs bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                      <RotateCcw className="h-3 w-3" /> Reworked {detailFull.reworkCount}×
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto">
                    {timeInStatus(detailFull.statusChangedAt)} in this status
                  </span>
                </div>

                {/* Description */}
                {detailFull.description && (
                  <p className="text-sm text-muted-foreground leading-relaxed">{detailFull.description}</p>
                )}

                {/* Assignment */}
                <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Assignment</h3>

                  {/* Assigned by (who requested/submitted the work) */}
                  <div className="flex items-center gap-2">
                    <User2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground w-20 shrink-0">
                      {detailFull.approvedBy ? 'Requested by' : 'Assigned by'}
                    </span>
                    {detailFull.assignedBy ? (
                      <div className="flex items-center gap-1.5">
                        <Avatar className="h-5 w-5">
                          <AvatarFallback className="text-[10px]">
                            {detailFull.assignedBy.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-medium">{detailFull.assignedBy.name}</span>
                        {detailFull.assignedBy.role && (
                          <span className="text-xs text-muted-foreground">({detailFull.assignedBy.role.replace(/_/g, ' ')})</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </div>

                  {/* Approved by — only shown for request-derived tasks */}
                  {detailFull.approvedBy && (
                    <div className="flex items-center gap-2">
                      <User2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
                      <span className="text-xs text-muted-foreground w-20 shrink-0">Approved by</span>
                      <div className="flex items-center gap-1.5">
                        <Avatar className="h-5 w-5">
                          <AvatarFallback className="text-[10px]">
                            {detailFull.approvedBy.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-medium text-green-700">{detailFull.approvedBy.name}</span>
                        {detailFull.approvedBy.role && (
                          <span className="text-xs text-muted-foreground">({detailFull.approvedBy.role.replace(/_/g, ' ')})</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Assigned to — editable for admin/manager/planner */}
                  <div className="flex items-start gap-2">
                    <User2 className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1" />
                    <span className="text-xs text-muted-foreground w-20 shrink-0 mt-0.5">Assigned to</span>
                    {canEditAssignee ? (
                      <div className="flex-1 space-y-1.5">
                        <Select
                          value={editAssigneeId}
                          onValueChange={(v) => setEditAssigneeId(v || null)}
                        >
                          <SelectTrigger className="h-8 text-sm">
                            <SelectValue placeholder="Unassigned" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">Unassigned</SelectItem>
                            {userOptions.filter(u => u.isActive !== false).map((u) => (
                              <SelectItem key={u.id} value={u.id}>
                                {u.name} <span className="text-muted-foreground text-xs">({u.role.replace(/_/g, ' ')})</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {assigneeChanged && (
                          <Button
                            size="sm"
                            className="h-7 text-xs"
                            onClick={saveAssignee}
                            disabled={savingAssignee}
                          >
                            {savingAssignee ? 'Saving…' : 'Save Assignee'}
                          </Button>
                        )}
                      </div>
                    ) : (
                      detailFull.owner ? (
                        <div className="flex items-center gap-1.5">
                          <Avatar className="h-5 w-5">
                            <AvatarFallback className="text-[10px]">
                              {detailFull.owner.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-sm font-medium">{detailFull.owner.name}</span>
                          {detailFull.owner.role && (
                            <span className="text-xs text-muted-foreground">({detailFull.owner.role.replace(/_/g, ' ')})</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">Unassigned</span>
                      )
                    )}
                  </div>

                  {/* Project / Workstream */}
                  <div className="flex items-center gap-2">
                    <Briefcase className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground w-20 shrink-0">Project</span>
                    <span className="text-sm">
                      {detailFull.workstream.project.name === '__direct_assignments__'
                        ? 'Direct Assignment'
                        : `${detailFull.workstream.project.name} · ${detailFull.workstream.name}`}
                    </span>
                  </div>
                </div>

                {/* Schedule + Hours */}
                <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Schedule & Hours</h3>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                    {detailFull.startDate && (
                      <>
                        <span className="text-muted-foreground text-xs">Start</span>
                        <span>{format(new Date(detailFull.startDate), 'MMM d, yyyy')}</span>
                      </>
                    )}
                    {detailFull.endDate && (
                      <>
                        <span className="text-muted-foreground text-xs">Due</span>
                        <span>{format(new Date(detailFull.endDate), 'MMM d, yyyy')}</span>
                      </>
                    )}
                    {detailFull.estimatedHours > 0 && (
                      <>
                        <span className="text-muted-foreground text-xs">Estimated</span>
                        <span>{detailFull.estimatedHours}h</span>
                      </>
                    )}
                    {detailFull.effortHours > 0 && (
                      <>
                        <span className="text-muted-foreground text-xs">Logged</span>
                        <span>{detailFull.effortHours}h</span>
                      </>
                    )}
                  </div>
                </div>

                {/* History */}
                {detailFull.history.length > 0 && (
                  <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                      <History className="h-3.5 w-3.5" /> Stage History
                    </h3>
                    <div className="space-y-1.5">
                      {detailFull.history.map((h) => (
                        <div key={h.id} className="flex items-start gap-2 text-xs">
                          <span className="text-muted-foreground shrink-0 w-20">
                            {format(new Date(h.changedAt), 'MMM d, HH:mm')}
                          </span>
                          <div className="flex-1 min-w-0">
                            <span className="text-muted-foreground">
                              {h.fromStatus ? `${STATUS_LABELS[h.fromStatus] ?? h.fromStatus} → ` : ''}
                            </span>
                            <span className="font-medium">{STATUS_LABELS[h.toStatus] ?? h.toStatus}</span>
                            {h.durationMinutes ? (
                              <span className="text-muted-foreground"> ({formatDur(h.durationMinutes)} in prev. stage)</span>
                            ) : null}
                            {h.changedBy && (
                              <span className="text-muted-foreground"> · {h.changedBy.name}</span>
                            )}
                            {h.note && (
                              <p className="text-muted-foreground italic mt-0.5">"{h.note}"</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
        </DialogContent>
      </Dialog>

      {/* Strategic task detail dialog */}
      <Dialog open={!!strategicDetailTask} onOpenChange={(o) => { if (!o) setStrategicDetailTask(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6">
              <span className="text-purple-500">★</span>
              <span className="leading-snug">{strategicDetailTask?.name}</span>
            </DialogTitle>
          </DialogHeader>
          {strategicDetailTask && (() => {
            const STATUS_COLORS_MAP: Record<string, string> = {
              BACKLOG: 'bg-slate-100 text-slate-700', PLANNED: 'bg-blue-100 text-blue-700',
              IN_PROGRESS: 'bg-yellow-100 text-yellow-800', REVIEW: 'bg-purple-100 text-purple-700',
              REWORK: 'bg-red-100 text-red-700', COMPLETED: 'bg-green-100 text-green-700',
              CANCELLED: 'bg-gray-100 text-gray-500',
            }
            const STATUS_LABELS: Record<string, string> = {
              BACKLOG: 'Backlog', PLANNED: 'Planned', IN_PROGRESS: 'In Progress',
              REVIEW: 'Review', REWORK: 'Rework', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
            }
            return (
              <div className="space-y-4 py-1">
                {/* Status + Strategic badge */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS_MAP[strategicDetailTask.status] ?? 'bg-purple-100 text-purple-700'}`}>
                    {STATUS_LABELS[strategicDetailTask.status] ?? strategicDetailTask.status}
                  </span>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                    Strategic
                  </span>
                </div>

                {/* Strategic Request name */}
                <p className="text-xs text-muted-foreground">
                  Request: <span className="font-medium text-foreground">{strategicDetailTask.workstream.name}</span>
                </p>

                {/* Assignment */}
                <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Assignment</h3>

                  {strategicDetailTask._submitterName && (
                    <div className="flex items-center gap-2">
                      <User2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground w-20 shrink-0">Assigned by</span>
                      <div className="flex items-center gap-1.5">
                        <Avatar className="h-5 w-5">
                          <AvatarFallback className="text-[10px]">
                            {strategicDetailTask._submitterName.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-medium">{strategicDetailTask._submitterName}</span>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <User2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground w-20 shrink-0">Assigned to</span>
                    {strategicDetailTask.owner ? (
                      <div className="flex items-center gap-1.5">
                        <Avatar className="h-5 w-5">
                          <AvatarFallback className="text-[10px]">
                            {strategicDetailTask.owner.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-medium">{strategicDetailTask.owner.name}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">Unassigned</span>
                    )}
                  </div>
                </div>

                {/* Schedule & Hours */}
                <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Schedule & Hours</h3>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                    {strategicDetailTask.startDate && (
                      <>
                        <span className="text-muted-foreground text-xs">Start</span>
                        <span>{format(new Date(strategicDetailTask.startDate), 'MMM d, yyyy')}</span>
                      </>
                    )}
                    {strategicDetailTask.endDate && (
                      <>
                        <span className="text-muted-foreground text-xs">Due</span>
                        <span>{format(new Date(strategicDetailTask.endDate), 'MMM d, yyyy')}</span>
                      </>
                    )}
                    {strategicDetailTask.estimatedHours > 0 && (
                      <>
                        <span className="text-muted-foreground text-xs">Estimated</span>
                        <span>{strategicDetailTask.estimatedHours}h</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="pt-1 border-t border-border">
                  <a href="/requests" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
                    → Manage in Strategic Requests
                  </a>
                </div>
              </div>
            )
          })()}
        </DialogContent>
      </Dialog>

      {/* Submit-for-review dialog */}
      <Dialog open={reviewOpen} onOpenChange={(v) => { if (!reviewLoading) setReviewOpen(v) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Submit for Review</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {reviewTarget && (
              <p className="text-sm text-muted-foreground">
                Task: <span className="font-medium text-foreground">{reviewTarget.name}</span>
              </p>
            )}
            {reviewTarget?.endDate && new Date(reviewTarget.endDate) < new Date() && (
              <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                ⚠ This task is past its deadline
                ({Math.round((Date.now() - new Date(reviewTarget.endDate).getTime()) / (24 * 60 * 60 * 1000))}d overdue).
                Please explain the delay below.
              </div>
            )}
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Comments / Delay reason <span className="text-destructive">*</span>
              </label>
              <Textarea
                placeholder="Describe what was completed and any reason for delay…"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                className="min-h-[100px] resize-none"
                autoFocus
              />
              {reviewNote.trim() === '' && (
                <p className="text-xs text-muted-foreground">Required — the reviewer will see this note.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewOpen(false)} disabled={reviewLoading}>
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={submitReview}
              disabled={reviewLoading || reviewNote.trim() === ''}
            >
              {reviewLoading ? 'Submitting…' : 'Submit for Review'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rework dialog */}
      <Dialog open={reworkOpen} onOpenChange={setReworkOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send Back for Rework</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {reworkTarget && (
              <p className="text-sm text-muted-foreground">
                Task: <span className="font-medium text-foreground">{reworkTarget.name}</span>
              </p>
            )}
            <Textarea
              placeholder="Optional note for the assignee..."
              value={reworkNote}
              onChange={(e) => setReworkNote(e.target.value)}
              className="min-h-[80px] resize-none"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReworkOpen(false)} disabled={reworkLoading}>
              Cancel
            </Button>
            <Button
              className="bg-orange-500 hover:bg-orange-600 text-white"
              onClick={submitRework}
              disabled={reworkLoading}
            >
              {reworkLoading ? 'Sending…' : 'Send for Rework'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
