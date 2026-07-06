'use client'

import { useRef, useState, useCallback, useEffect } from 'react'
import { useAuthStore } from '@/store/auth'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  addDays, differenceInCalendarDays, format, isSameDay, isWeekend,
  eachDayOfInterval, endOfWeek, startOfWeek,
} from 'date-fns'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Calendar, Pencil, X } from 'lucide-react'

interface TaskOwner { id: string; name: string }
interface Task {
  id: string
  name: string
  status: string
  priority: string
  startDate?: string
  endDate?: string
  actualStartDate?: string
  actualEndDate?: string
  description?: string
  comments?: string
  owner?: TaskOwner
}
interface Workstream {
  id: string
  name: string
  tasks: Task[]
}
interface Product {
  id: string
  brand: string
  modelNo: string
}
interface Project {
  id: string
  startDate: string
  endDate: string
  leadId?: string | null
  editAccessGranted?: boolean
  workstreams: Workstream[]
}

const STATUS_BG: Record<string, string> = {
  BACKLOG: 'bg-slate-400',
  PLANNED: 'bg-blue-500',
  IN_PROGRESS: 'bg-yellow-500',
  REVIEW: 'bg-purple-500',
  REWORK: 'bg-orange-500',
  COMPLETED: 'bg-green-500',
  CANCELLED: 'bg-red-400',
}

const STATUS_HOVER: Record<string, string> = {
  BACKLOG: 'hover:bg-slate-500',
  PLANNED: 'hover:bg-blue-600',
  IN_PROGRESS: 'hover:bg-yellow-600',
  REVIEW: 'hover:bg-purple-600',
  REWORK: 'hover:bg-orange-600',
  COMPLETED: 'hover:bg-green-600',
  CANCELLED: 'hover:bg-red-500',
}

const LABEL_W = 220
const ROW_H = 42
const HEADER_H = 52

type DragType = 'move' | 'resize-left' | 'resize-right'

interface DragState {
  taskId: string
  type: DragType
  startX: number
  origStart: Date
  origEnd: Date
}

type GanttRow =
  | { type: 'ws'; ws: Workstream; label: string }
  | { type: 'product'; productId: string; label: string }
  | { type: 'task'; ws: Workstream; task: Task; label: string }

export function ProjectGanttView({
  project,
  onRefresh,
}: {
  project: Project
  onRefresh: () => void
}) {
  const { user } = useAuthStore()
  const canEditDates = !!(user && (
    ['ADMIN', 'MANAGER', 'PLANNER'].includes(user.role) ||
    (user.role === 'PROJECT_LEAD' && project.leadId === user.id && project.editAccessGranted)
  ))

  const [dayW, setDayW] = useState(28)
  const [viewStart, setViewStart] = useState(() => {
    const d = new Date(project.startDate)
    d.setDate(1)
    return d
  })
  const [dragging, setDragging] = useState<DragState | null>(null)
  const [dragDeltaDays, setDragDeltaDays] = useState(0)
  const [saving, setSaving] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [editTask, setEditTask] = useState<{ task: Task; label: string } | null>(null)
  const [actualStart, setActualStart] = useState('')
  const [actualEnd, setActualEnd] = useState('')
  const [taskComment, setTaskComment] = useState('')
  const [savingActual, setSavingActual] = useState(false)
  const [chartW, setChartW] = useState(900)

  const chartRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

  useEffect(() => {
    fetch(`/api/projects/${project.id}/products`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setProducts(d) })
      .catch(() => {})
  }, [project.id])

  useEffect(() => {
    const el = chartRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setChartW(el.clientWidth)
    })
    ro.observe(el)
    setChartW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const today = new Date()
  const calendarW = Math.max(600, chartW - LABEL_W - 4)
  const viewEnd = addDays(viewStart, Math.ceil(calendarW / dayW))
  const days = eachDayOfInterval({ start: viewStart, end: viewEnd })

  const weeks: Array<{ label: string; days: Date[] }> = []
  let wk = startOfWeek(viewStart, { weekStartsOn: 1 })
  while (wk <= viewEnd) {
    const wEnd = endOfWeek(wk, { weekStartsOn: 1 })
    const wDays = days.filter((d) => d >= wk && d <= wEnd)
    if (wDays.length > 0) weeks.push({ label: format(wk, 'MMM d'), days: wDays })
    wk = addDays(wEnd, 1)
  }

  // A workstream is "per-product" only when it actually contains tagged tasks.
  // Name-based detection caused shared workstreams (e.g. Refrigeration "Costing") to
  // disappear from both common and product sections.
  const perProductWsIds = new Set(
    project.workstreams
      .filter((ws) => ws.tasks.some((t) => t.description?.match(/__productTask:[^:]+:/)))
      .map((ws) => ws.id)
  )

  // Workstreams to hide from Gantt entirely (report/deliverables tab only)
  function isReportOnly(name: string) {
    const lower = name.toLowerCase()
    return lower.includes('report') || lower === 'deliverables'
  }

  const allRows: GanttRow[] = []

  // 1. Common workstreams shown once at top (skip per-product, report-only, and empty)
  for (const ws of project.workstreams) {
    if (perProductWsIds.has(ws.id) || isReportOnly(ws.name) || ws.tasks.length === 0) continue
    allRows.push({ type: 'ws', ws, label: ws.name })
    for (const task of ws.tasks) allRows.push({ type: 'task', ws, task, label: ws.name })
  }

  // 2. Per-product workstreams — gather ALL tagged tasks, group under one product header each
  if (perProductWsIds.size > 0 || products.length > 0) {
    const productTaskMap = new Map<string, { task: Task; ws: Workstream }[]>()

    for (const ws of project.workstreams) {
      if (!perProductWsIds.has(ws.id)) continue
      for (const task of ws.tasks) {
        const match = task.description?.match(/__productTask:([^:]+):/)
        if (match) {
          const pid = match[1]
          if (!productTaskMap.has(pid)) productTaskMap.set(pid, [])
          productTaskMap.get(pid)!.push({ task, ws })
        }
      }
    }

    // Show all products — even those without tagged tasks yet
    const orderedIds = products.length > 0
      ? products.map((p) => p.id)
      : [...productTaskMap.keys()]

    for (const pid of orderedIds) {
      const taskList = productTaskMap.get(pid) ?? []
      const p = products.find((pr) => pr.id === pid)
      const label = p ? `${p.brand}${p.modelNo ? ` ${p.modelNo}` : ''}` : pid
      allRows.push({ type: 'product', productId: pid, label })
      for (const { task, ws } of taskList) {
        allRows.push({ type: 'task', ws, task, label })
      }
    }
  }

  function getBarStyle(start?: string, end?: string): { left: number; width: number; visible: boolean } {
    if (!start || !end) return { left: 0, width: 0, visible: false }
    const s = new Date(start)
    const e = new Date(end)
    const left = differenceInCalendarDays(s, viewStart) * dayW
    const width = Math.max(dayW, (differenceInCalendarDays(e, s) + 1) * dayW - 2)
    const visible = left < days.length * dayW && left + width > 0
    return { left, width, visible }
  }

  function getDragAdjustedBar(task: Task) {
    if (!dragging || dragging.taskId !== task.id) return getBarStyle(task.startDate, task.endDate)
    const { type, origStart, origEnd } = dragging
    const delta = dragDeltaDays
    let s = new Date(origStart)
    let e = new Date(origEnd)
    if (type === 'move') { s = addDays(s, delta); e = addDays(e, delta) }
    else if (type === 'resize-left') { s = addDays(s, delta) }
    else if (type === 'resize-right') { e = addDays(e, delta) }
    if (s > e) { if (type === 'resize-left') s = e; else e = s }
    const left = differenceInCalendarDays(s, viewStart) * dayW
    const width = Math.max(dayW, (differenceInCalendarDays(e, s) + 1) * dayW - 2)
    const visible = left < days.length * dayW && left + width > 0
    return { left, width, visible }
  }

  const handlePointerDown = useCallback((
    e: React.PointerEvent,
    task: Task,
    type: DragType,
  ) => {
    if (!canEditDates) return
    if (!task.startDate || !task.endDate) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const state: DragState = {
      taskId: task.id,
      type,
      startX: e.clientX,
      origStart: new Date(task.startDate),
      origEnd: new Date(task.endDate),
    }
    dragRef.current = state
    setDragging(state)
    setDragDeltaDays(0)
  }, [canEditDates])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const delta = Math.round((e.clientX - dragRef.current.startX) / dayW)
    setDragDeltaDays(delta)
  }, [dayW])

  const handlePointerUp = useCallback(async (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null

    const dx = e.clientX - drag.startX
    const delta = Math.round(dx / dayW)

    let newStart = new Date(drag.origStart)
    let newEnd = new Date(drag.origEnd)

    if (drag.type === 'move') {
      newStart = addDays(newStart, delta)
      newEnd = addDays(newEnd, delta)
    } else if (drag.type === 'resize-left') {
      newStart = addDays(newStart, delta)
      if (newStart > newEnd) newStart = newEnd
    } else if (drag.type === 'resize-right') {
      newEnd = addDays(newEnd, delta)
      if (newEnd < newStart) newEnd = newStart
    }

    const origS = drag.origStart.toISOString().slice(0, 10)
    const origE = drag.origEnd.toISOString().slice(0, 10)
    const newS = newStart.toISOString().slice(0, 10)
    const newE = newEnd.toISOString().slice(0, 10)

    setDragging(null)
    setDragDeltaDays(0)

    if (newS === origS && newE === origE) return

    setSaving(true)
    try {
      const res = await fetch(`/api/tasks/${drag.taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: newS, endDate: newE }),
      })
      if (!res.ok) throw new Error()
      onRefresh()
    } catch {
      toast.error('Failed to update task dates')
    } finally {
      setSaving(false)
    }
  }, [dayW, onRefresh])

  function openEditTask(task: Task, label: string) {
    setEditTask({ task, label })
    setActualStart(task.actualStartDate?.slice(0, 10) || '')
    setActualEnd(task.actualEndDate?.slice(0, 10) || '')
    setTaskComment(task.comments || '')
  }

  async function saveActualDates() {
    if (!editTask) return
    setSavingActual(true)
    try {
      const res = await fetch(`/api/tasks/${editTask.task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actualStartDate: actualStart || null,
          actualEndDate: actualEnd || null,
          comments: taskComment || null,
        }),
      })
      if (!res.ok) throw new Error()
      toast.success('Actual dates saved')
      onRefresh()
      setEditTask(null)
    } catch {
      toast.error('Failed to save actual dates')
    } finally {
      setSavingActual(false)
    }
  }

  const todayOffset = differenceInCalendarDays(today, viewStart) * dayW

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setViewStart((d) => addDays(d, -30))}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => {
          const d = new Date(); d.setDate(1); setViewStart(d)
        }}>
          <Calendar className="h-3 w-3 mr-1" /> Today
        </Button>
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setViewStart((d) => addDays(d, 30))}>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <div className="flex items-center gap-1 ml-2">
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setDayW((w) => Math.max(14, w - 4))}>
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground w-12 text-center">{dayW}px/day</span>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setDayW((w) => Math.min(56, w + 4))}>
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
        </div>
        {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
        {canEditDates && !saving && (
          <span className="text-xs text-muted-foreground ml-auto">Drag bars to move · ✏ to record actual dates</span>
        )}
      </div>

      {/* Chart + edit panel */}
      <div className="flex gap-3 flex-1 min-h-0">
        {/* Gantt chart */}
        <div className="flex-1 min-w-0 border rounded-lg overflow-hidden">
          <div
            className="overflow-auto"
            style={{ maxHeight: '60vh' }}
            ref={chartRef}
            onPointerMove={dragging ? handlePointerMove : undefined}
            onPointerUp={dragging ? handlePointerUp : undefined}
          >
            {/* Sticky header */}
            <div className="flex sticky top-0 z-20 bg-background border-b">
              <div style={{ width: LABEL_W, minWidth: LABEL_W, height: HEADER_H }} className="shrink-0 border-r bg-muted/50 px-3 flex items-end pb-1 text-xs font-medium text-muted-foreground">
                Task
              </div>
              <div className="flex shrink-0">
                {weeks.map((week, wi) => (
                  <div key={wi} className="border-r last:border-0">
                    <div
                      className="px-2 py-1 text-xs font-medium text-muted-foreground border-b bg-muted/30 whitespace-nowrap"
                      style={{ width: week.days.length * dayW }}
                    >
                      {week.label}
                    </div>
                    <div className="flex">
                      {week.days.map((day) => (
                        <div
                          key={day.toISOString()}
                          style={{ width: dayW }}
                          className={`text-center text-[10px] py-0.5 border-r last:border-0 ${
                            isSameDay(day, today) ? 'bg-blue-100 text-blue-700 font-bold dark:bg-blue-950' :
                            isWeekend(day) ? 'bg-muted/60 text-muted-foreground/40' : 'text-muted-foreground'
                          }`}
                        >
                          {dayW >= 20 ? day.getDate() : ''}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Rows */}
            {allRows.map((row, ri) => {
              if (row.type === 'product') {
                return (
                  <div key={`product-${row.productId}-${ri}`} className="flex border-b bg-primary/5 dark:bg-primary/10">
                    <div
                      style={{ width: LABEL_W, minWidth: LABEL_W, height: ROW_H }}
                      className="shrink-0 border-r px-3 flex items-center text-xs font-bold text-primary tracking-wide"
                    >
                      {row.label}
                    </div>
                    <div className="relative flex-1" style={{ height: ROW_H }}>
                      {days.map((day, di) => isWeekend(day) ? (
                        <div key={di} className="absolute top-0 bottom-0 bg-muted/40" style={{ left: di * dayW, width: dayW }} />
                      ) : null)}
                      {todayOffset >= 0 && (
                        <div className="absolute top-0 bottom-0 w-px bg-blue-500/60 z-10" style={{ left: todayOffset }} />
                      )}
                    </div>
                  </div>
                )
              }

              if (row.type === 'ws') {
                return (
                  <div key={`ws-${row.ws.id}-${ri}`} className="flex border-b bg-muted/20">
                    <div
                      style={{ width: LABEL_W, minWidth: LABEL_W, height: ROW_H }}
                      className="shrink-0 border-r px-3 flex items-center text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                    >
                      {row.label}
                    </div>
                    <div className="relative flex-1" style={{ height: ROW_H }}>
                      {days.map((day, di) => isWeekend(day) ? (
                        <div key={di} className="absolute top-0 bottom-0 bg-muted/40" style={{ left: di * dayW, width: dayW }} />
                      ) : null)}
                      {todayOffset >= 0 && (
                        <div className="absolute top-0 bottom-0 w-px bg-blue-500/60 z-10" style={{ left: todayOffset }} />
                      )}
                    </div>
                  </div>
                )
              }

              const task = row.task
              const { left, width, visible } = getDragAdjustedBar(task)
              const actualBar = getBarStyle(task.actualStartDate, task.actualEndDate)
              const isDragging = dragging?.taskId === task.id
              const isEditing = editTask?.task.id === task.id

              return (
                <div
                  key={`task-${task.id}`}
                  className={`flex border-b transition-colors group ${isEditing ? 'bg-emerald-50 dark:bg-emerald-950/20' : 'hover:bg-muted/10'}`}
                >
                  {/* Label */}
                  <div
                    style={{ width: LABEL_W, minWidth: LABEL_W, height: ROW_H }}
                    className="shrink-0 border-r px-3 flex items-center gap-2 text-xs overflow-hidden"
                  >
                    <div className={`h-1.5 w-1.5 rounded-full shrink-0 ${STATUS_BG[task.status] || 'bg-slate-400'}`} />
                    <span className="truncate flex-1" title={task.name}>{task.name}</span>
                    {task.owner && (
                      <span className="shrink-0 text-[10px] text-muted-foreground truncate max-w-[50px]">
                        {task.owner.name.split(' ')[0]}
                      </span>
                    )}
                    {(canEditDates || task.owner?.id === user?.id) && (
                      <button
                        className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                        onClick={() => openEditTask(task, row.label)}
                        title="Record actual dates"
                      >
                        <Pencil className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>

                  {/* Timeline area */}
                  <div
                    className="relative flex-1 select-none"
                    style={{ height: ROW_H }}
                  >
                    {days.map((day, di) => isWeekend(day) ? (
                      <div key={di} className="absolute top-0 bottom-0 bg-muted/40" style={{ left: di * dayW, width: dayW }} />
                    ) : null)}
                    {todayOffset >= 0 && (
                      <div className="absolute top-0 bottom-0 w-px bg-blue-500/60 z-10" style={{ left: todayOffset }} />
                    )}

                    {/* Planned bar */}
                    {visible && (
                      <div
                        className={`absolute rounded flex items-center text-white text-[10px] font-medium overflow-hidden transition-opacity ${STATUS_BG[task.status]} ${STATUS_HOVER[task.status]} ${isDragging ? 'opacity-80 shadow-lg ring-2 ring-white/40 cursor-grabbing' : canEditDates ? 'cursor-grab' : 'cursor-default'}`}
                        style={{ left: Math.max(0, left), width, top: 3, height: 18 }}
                      >
                        {canEditDates && (
                          <div
                            className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 hover:bg-black/20"
                            onPointerDown={(e) => handlePointerDown(e, task, 'resize-left')}
                          />
                        )}
                        <div
                          className="flex-1 px-2 overflow-hidden whitespace-nowrap select-none"
                          onPointerDown={canEditDates ? (e) => handlePointerDown(e, task, 'move') : undefined}
                          style={{ cursor: canEditDates ? 'grab' : 'default' }}
                        >
                          {width > 60 && task.name}
                        </div>
                        {canEditDates && (
                          <div
                            className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 hover:bg-black/20"
                            onPointerDown={(e) => handlePointerDown(e, task, 'resize-right')}
                          />
                        )}
                      </div>
                    )}

                    {/* Actual bar — emerald, below the planned bar */}
                    {actualBar.visible && (
                      <div
                        className="absolute rounded-sm bg-emerald-500/80"
                        style={{ left: Math.max(0, actualBar.left), width: actualBar.width, top: 26, height: 10 }}
                        title={`Actual: ${task.actualStartDate?.slice(0, 10)} – ${task.actualEndDate?.slice(0, 10)}`}
                      />
                    )}

                    {!task.startDate && (
                      <div className="absolute inset-y-0 left-2 flex items-center">
                        <span className="text-[10px] text-muted-foreground/50">no dates</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Actual dates edit panel */}
        {editTask && (
          <div className="w-60 shrink-0 border rounded-lg bg-background p-4 flex flex-col gap-4 self-start">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight truncate">{editTask.task.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{editTask.label}</p>
              </div>
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setEditTask(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {(editTask.task.startDate || editTask.task.endDate) && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <div className={`h-2 w-2 rounded-sm shrink-0 ${STATUS_BG[editTask.task.status]}`} />
                  <span className="text-xs font-medium">Planned</span>
                </div>
                <p className="text-xs text-muted-foreground pl-3.5">
                  {editTask.task.startDate ? format(new Date(editTask.task.startDate), 'MMM d') : '?'}
                  {' – '}
                  {editTask.task.endDate ? format(new Date(editTask.task.endDate), 'MMM d, yyyy') : '?'}
                </p>
              </div>
            )}

            <div className="space-y-3">
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-sm bg-emerald-500 shrink-0" />
                <span className="text-xs font-medium">Actual Dates</span>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Start</Label>
                <Input
                  type="date"
                  className="h-7 text-xs"
                  value={actualStart}
                  onChange={(e) => setActualStart(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">End</Label>
                <Input
                  type="date"
                  className="h-7 text-xs"
                  value={actualEnd}
                  onChange={(e) => setActualEnd(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Comments</Label>
              <Textarea
                placeholder="Add a comment or note…"
                rows={3}
                value={taskComment}
                onChange={(e) => setTaskComment(e.target.value)}
                className="text-xs resize-none"
              />
            </div>

            <Button size="sm" className="w-full" onClick={saveActualDates} disabled={savingActual}>
              {savingActual ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 flex-wrap">
        {Object.entries(STATUS_BG).map(([status, bg]) => (
          <div key={status} className="flex items-center gap-1.5">
            <div className={`h-3 w-3 rounded ${bg}`} />
            <span className="text-xs text-muted-foreground capitalize">{status.replace(/_/g, ' ').toLowerCase()}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-4 rounded-sm bg-emerald-500/80" />
          <span className="text-xs text-muted-foreground">Actual</span>
        </div>
        {!canEditDates && (
          <span className="ml-auto text-xs text-muted-foreground">
            Only planners, or a project lead with edit access granted, can edit dates
          </span>
        )}
      </div>
    </div>
  )
}
