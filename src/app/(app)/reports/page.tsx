'use client'

import { useEffect, useState, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { BarChart3, Target, Users, FolderKanban, User, Clock, CalendarDays, TrendingUp } from 'lucide-react'
import { useAuthStore } from '@/store/auth'

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMondayOf(d: Date): Date {
  const day = new Date(d)
  day.setHours(0, 0, 0, 0)
  const dow = day.getDay()
  const diff = dow === 0 ? -6 : 1 - dow
  day.setDate(day.getDate() + diff)
  return day
}

const STATUS_COLORS: Record<string, string> = {
  BACKLOG:     'bg-slate-100 text-slate-600',
  PLANNED:     'bg-blue-100 text-blue-700',
  IN_PROGRESS: 'bg-amber-100 text-amber-700',
  REVIEW:      'bg-purple-100 text-purple-700',
  REWORK:      'bg-orange-100 text-orange-700',
  COMPLETED:   'bg-green-100 text-green-700',
  CANCELLED:   'bg-red-100 text-red-600',
}

// Status buckets shown in the "Specific Day" breakdown, in display order
const DAY_STATUS_BUCKETS = ['BACKLOG', 'PLANNED', 'IN_PROGRESS', 'REVIEW', 'REWORK', 'COMPLETED'] as const

function barColor(hours: number, cap: number) {
  if (cap <= 0) return 'bg-blue-400'
  const pct = hours / cap
  if (pct > 1) return 'bg-red-500'
  if (pct > 0.85) return 'bg-orange-400'
  if (pct > 0.6) return 'bg-amber-400'
  return 'bg-green-400'
}

// ── Interfaces ────────────────────────────────────────────────────────────────

interface MyTask {
  id: string; name: string; status: string; priority: string
  estimatedHours?: number; startDate?: string; endDate?: string; pctComplete?: number
  statusChangedAt?: string
  workstream: { name: string; project: { id: string; name: string } }
}

interface Project {
  id: string; name: string; type: string; status: string; priority: string
  planner?: { id: string; name: string }
  workstreams: Array<{ tasks: Array<{ id: string; status: string }> }>
  allocations: Array<{ allocationPct: number; userId: string }>
}

interface PortfolioResource {
  id: string; name: string; role: string; utilizationPct: number; isOverloaded: boolean; activeTasks: number
}

function TaskRow({ t }: { t: MyTask }) {
  return (
    <div className="px-4 py-3 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{t.name}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_COLORS[t.status] ?? 'bg-muted text-muted-foreground'}`}>
            {t.status.replace('_', ' ')}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t.workstream.project.name} · {t.workstream.name}
        </p>
        {(t.startDate || t.endDate) && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {t.startDate ? new Date(t.startDate.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'}
            {' → '}
            {t.endDate ? new Date(t.endDate.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'}
          </p>
        )}
      </div>
      <div className="text-right shrink-0">
        {t.estimatedHours != null && (
          <p className="text-sm font-semibold">{t.estimatedHours}h</p>
        )}
        {t.pctComplete != null && (
          <div className="flex items-center gap-1 mt-1">
            <Progress value={t.pctComplete} className="w-16 h-1.5" />
            <span className="text-[10px] text-muted-foreground">{t.pctComplete}%</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Personal utilization report (RESOURCE users) ─────────────────────────────

function MyUtilizationReport({ userId }: { userId: string }) {
  type Period = '3m' | '6m' | 'week' | 'day'

  const todayStr = new Date().toISOString().slice(0, 10)
  const [period, setPeriod]       = useState<Period>('week')
  const [specificDay, setDay]     = useState(todayStr)
  const [dailyMap, setDailyMap]   = useState<Record<string, number>>({})
  const [capacityPct, setCap]     = useState(100)
  const [tasks, setTasks]         = useState<MyTask[]>([])
  const [loading, setLoading]     = useState(false)

  const dateRange = useMemo(() => {
    const now = new Date(); now.setHours(0, 0, 0, 0)
    if (period === '3m') {
      const from = new Date(now); from.setMonth(from.getMonth() - 3)
      return { from: from.toISOString().slice(0, 10), to: todayStr }
    }
    if (period === '6m') {
      const from = new Date(now); from.setMonth(from.getMonth() - 6)
      return { from: from.toISOString().slice(0, 10), to: todayStr }
    }
    if (period === 'week') {
      const mon = getMondayOf(now)
      const fri = new Date(mon); fri.setDate(fri.getDate() + 4)
      return { from: mon.toISOString().slice(0, 10), to: fri.toISOString().slice(0, 10) }
    }
    return { from: specificDay, to: specificDay }
  }, [period, specificDay, todayStr])

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetch(`/api/resources?from=${dateRange.from}&to=${dateRange.to}`).then(r => r.json()),
      fetch(`/api/tasks?ownerId=${userId}`).then(r => r.json()),
    ]).then(([resources, allTasks]) => {
      const me = Array.isArray(resources) ? resources.find((r: { id: string }) => r.id === userId) : null
      setDailyMap(me?.dailyHoursMap ?? {})
      setCap(me?.capacityPct ?? 100)
      setTasks(Array.isArray(allTasks) ? allTasks : [])
    }).catch(() => {}).finally(() => setLoading(false))
  }, [dateRange, userId])

  const dailyCap   = Math.round(8  * capacityPct / 100 * 10) / 10
  const weeklyCap  = Math.round(40 * capacityPct / 100 * 10) / 10

  // Group dailyMap by ISO week for 3m/6m views
  const weeklyBars = useMemo(() => {
    if (period !== '3m' && period !== '6m') return []
    const weekMap: Record<string, number> = {}
    Object.entries(dailyMap).forEach(([date, hours]) => {
      const mon = getMondayOf(new Date(date + 'T00:00:00')).toISOString().slice(0, 10)
      weekMap[mon] = (weekMap[mon] ?? 0) + hours
    })
    return Object.entries(weekMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mon, total]) => ({
        label: new Date(mon + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        total: Math.round(total * 10) / 10,
      }))
  }, [dailyMap, period])

  // Daily bars for week / day views
  const dailyBars = useMemo(() => {
    if (period !== 'week' && period !== 'day') return []
    return Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, hours]) => ({
        label: new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        total: Math.round(hours * 10) / 10,
        date,
      }))
  }, [dailyMap, period])

  const bars   = period === 'week' || period === 'day' ? dailyBars : weeklyBars
  const barCap = period === 'week' || period === 'day' ? dailyCap : weeklyCap
  // Scale to actual data so bars fill the chart height and colors are visible
  const maxVal = Math.max(...bars.map(b => b.total), 0.001)

  const totalHours   = Math.round(Object.values(dailyMap).reduce((s, h) => s + h, 0) * 10) / 10
  const workingDays  = Object.keys(dailyMap).length
  const avgDaily     = workingDays > 0 ? Math.round(totalHours / workingDays * 10) / 10 : 0
  const utilPct      = period === 'week' && weeklyCap > 0
    ? Math.round(totalHours / weeklyCap * 100)
    : period === 'day' && dailyCap > 0
      ? Math.round(totalHours / dailyCap * 100)
      : 0

  // Tasks overlapping the date range — overdue IN_PROGRESS/REWORK tasks always included
  const tasksInPeriod = useMemo(() => {
    return tasks.filter(t => {
      if (
        (t.status === 'IN_PROGRESS' || t.status === 'REWORK') &&
        t.endDate && t.endDate.slice(0, 10) < dateRange.from
      ) return true
      const ts = t.startDate?.slice(0, 10) ?? '0000-00-00'
      const te = t.endDate?.slice(0, 10)   ?? '9999-12-31'
      return ts <= dateRange.to && te >= dateRange.from
    })
  }, [tasks, dateRange])

  // Status-bucketed breakdown for the "Specific Day" view — tasks active on that exact date,
  // grouped by current status. COMPLETED matches by actual completion day (statusChangedAt),
  // not the originally planned end date, so it reflects what was actually finished that day.
  const dayBuckets = useMemo(() => {
    if (period !== 'day') return null
    const buckets: Record<string, MyTask[]> = Object.fromEntries(DAY_STATUS_BUCKETS.map(s => [s, []]))
    for (const t of tasks) {
      if (!(t.status in buckets)) continue
      if (t.status === 'COMPLETED') {
        if (t.statusChangedAt?.slice(0, 10) === specificDay) buckets.COMPLETED.push(t)
        continue
      }
      const ts = t.startDate?.slice(0, 10)
      const te = t.endDate?.slice(0, 10)
      if (!ts || !te) continue
      const overdue = (t.status === 'IN_PROGRESS' || t.status === 'REWORK') && te < specificDay
      if (overdue || (ts <= specificDay && specificDay <= te)) buckets[t.status].push(t)
    }
    return buckets
  }, [tasks, period, specificDay])

  const dayTaskCount = dayBuckets
    ? Object.values(dayBuckets).reduce((s, arr) => s + arr.length, 0)
    : 0

  const PERIOD_LABELS: Record<Period, string> = {
    '3m': 'Last 3 Months', '6m': 'Last 6 Months', 'week': 'This Week', 'day': 'Specific Day',
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <User className="h-6 w-6 text-blue-500" /> My Utilization Report
          </h1>
          <p className="text-muted-foreground text-sm">Your personal work summary — visible only to you</p>
        </div>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-lg border overflow-hidden text-sm">
          {(['3m', '6m', 'week', 'day'] as Period[]).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 transition-colors ${period === p ? 'bg-blue-600 text-white' : 'hover:bg-muted'}`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        {period === 'day' && (
          <Input
            type="date"
            value={specificDay}
            onChange={e => setDay(e.target.value)}
            className="w-40 h-8 text-sm"
          />
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-32 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      ) : (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card><CardContent className="p-4">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" /> Total Hours</p>
              <p className="text-3xl font-bold mt-1">{totalHours}h</p>
              <p className="text-xs text-muted-foreground mt-1">in selected period</p>
            </CardContent></Card>

            <Card><CardContent className="p-4">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3 w-3" /> Avg / Day</p>
              <p className="text-3xl font-bold mt-1">{avgDaily}h</p>
              <p className="text-xs text-muted-foreground mt-1">capacity: {dailyCap}h/day</p>
            </CardContent></Card>

            <Card><CardContent className="p-4">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><CalendarDays className="h-3 w-3" /> Tasks</p>
              <p className="text-3xl font-bold mt-1">{dayBuckets ? dayTaskCount : tasksInPeriod.length}</p>
              <p className="text-xs text-muted-foreground mt-1">in this period</p>
            </CardContent></Card>

            <Card><CardContent className="p-4">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Target className="h-3 w-3" /> Utilization</p>
              <p className={`text-3xl font-bold mt-1 ${utilPct > 100 ? 'text-red-600' : utilPct > 85 ? 'text-orange-500' : 'text-green-600'}`}>
                {period === 'week' || period === 'day' ? `${utilPct}%` : '—'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">vs capacity</p>
            </CardContent></Card>
          </div>

          {/* Utilization bar chart */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-blue-500" />
                {period === 'week' || period === 'day' ? 'Daily Hours' : 'Weekly Hours'}
                <span className="text-xs font-normal text-muted-foreground ml-1">
                  (capacity line = {barCap}h)
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {bars.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No hours logged for this period</p>
              ) : (
                <div className="overflow-x-auto">
                  <div className="flex items-end gap-2 min-w-max pb-1" style={{ height: 160 }}>
                    {bars.map((bar, i) => {
                      const pct = (bar.total / maxVal) * 100
                      // Clamp at 95% so the capacity line is always visible inside the chart
                      const capPct = Math.min((barCap / maxVal) * 100, 95)
                      return (
                        <div key={i} className="flex flex-col items-center gap-1" style={{ minWidth: period === '3m' || period === '6m' ? 36 : 60 }}>
                          <span className="text-[10px] text-muted-foreground">{bar.total > 0 ? `${bar.total}h` : ''}</span>
                          <div className="relative w-full flex-1 flex items-end" style={{ height: 120 }}>
                            {/* Capacity marker */}
                            <div
                              className="absolute w-full border-t-2 border-dashed border-blue-300 opacity-60"
                              style={{ bottom: `${capPct}%` }}
                            />
                            {/* Bar — only render when there are hours so 0h days are visually clean */}
                            {bar.total > 0 && (
                              <div
                                className={`w-full rounded-t transition-all ${barColor(bar.total, barCap)}`}
                                style={{ height: `${Math.max(pct, 8)}%` }}
                              />
                            )}
                          </div>
                          <span className="text-[10px] text-muted-foreground text-center leading-tight" style={{ maxWidth: 56 }}>
                            {bar.label}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  {/* Legend */}
                  <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-green-400 inline-block" /> &lt;60%</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-amber-400 inline-block" /> 60–85%</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-orange-400 inline-block" /> 85–100%</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-red-500 inline-block" /> Over</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-4 border-t-2 border-dashed border-blue-300" /> Capacity</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Task list for period — status-bucketed breakdown for a specific day, flat list otherwise */}
          {period === 'day' && dayBuckets ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {DAY_STATUS_BUCKETS.map(status => {
                const bucketTasks = dayBuckets[status]
                return (
                  <Card key={status}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_COLORS[status]}`}>
                          {status.replace('_', ' ')}
                        </span>
                        <Badge variant="secondary" className="ml-auto">{bucketTasks.length}</Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      {bucketTasks.length === 0 ? (
                        <p className="text-xs text-muted-foreground p-4 text-center">None</p>
                      ) : (
                        <div className="divide-y max-h-72 overflow-y-auto">
                          {bucketTasks.map(t => <TaskRow key={t.id} t={t} />)}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Target className="h-4 w-4 text-green-500" />
                  My Tasks — {PERIOD_LABELS[period]}
                  <Badge variant="secondary" className="ml-1">{tasksInPeriod.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {tasksInPeriod.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-4 text-center">No tasks in this period</p>
                ) : (
                  <div className="divide-y">
                    {tasksInPeriod.map(t => <TaskRow key={t.id} t={t} />)}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { user } = useAuthStore()
  const canManage = ['ADMIN', 'MANAGER', 'PLANNER'].includes(user?.role ?? '')

  const [projects,  setProjects]  = useState<Project[]>([])
  const [resources, setResources] = useState<PortfolioResource[]>([])
  const [loading,   setLoading]   = useState(true)

  useEffect(() => {
    if (!canManage) { setLoading(false); return }
    Promise.all([
      fetch('/api/projects').then(r => r.json()),
      fetch('/api/resources').then(r => r.json()),
    ]).then(([p, r]) => {
      setProjects(Array.isArray(p) ? p : [])
      setResources(Array.isArray(r) ? r : [])
      setLoading(false)
    })
  }, [canManage])

  // Non-managers (RESOURCE, PROJECT_LEAD, WORKSTREAM_LEAD, LEADERSHIP) get personal utilization
  if (!canManage && user) return <MyUtilizationReport userId={user.id} />

  if (loading) return <div className="p-6"><Skeleton className="h-96 rounded-lg" /></div>

  // ── Portfolio view (managers / planners / admins) ──
  const byStatus = {
    PLANNING:  projects.filter(p => p.status === 'PLANNING').length,
    ACTIVE:    projects.filter(p => p.status === 'ACTIVE').length,
    ON_HOLD:   projects.filter(p => p.status === 'ON_HOLD').length,
    COMPLETED: projects.filter(p => p.status === 'COMPLETED').length,
    CANCELLED: projects.filter(p => p.status === 'CANCELLED').length,
  }

  const byType = {
    TEARDOWN: projects.filter(p => p.type === 'TEARDOWN').length,
    OTHER:    projects.filter(p => p.type === 'OTHER').length,
  }

  const allTasks = projects.flatMap(p => p.workstreams.flatMap(ws => ws.tasks))
  const tasksByStatus = {
    BACKLOG:     allTasks.filter(t => t.status === 'BACKLOG').length,
    PLANNED:     allTasks.filter(t => t.status === 'PLANNED').length,
    IN_PROGRESS: allTasks.filter(t => t.status === 'IN_PROGRESS').length,
    REVIEW:      allTasks.filter(t => t.status === 'REVIEW').length,
    COMPLETED:   allTasks.filter(t => t.status === 'COMPLETED').length,
  }

  const completionRate = allTasks.length
    ? Math.round((tasksByStatus.COMPLETED / allTasks.length) * 100) : 0
  const avgUtilization = resources.length
    ? Math.round(resources.reduce((s, r) => s + r.utilizationPct, 0) / resources.length) : 0

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-blue-500" /> Portfolio Reports
        </h1>
        <p className="text-muted-foreground text-sm">Snapshot as of today</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Total Projects</p>
          <p className="text-3xl font-bold mt-1">{projects.length}</p>
          <p className="text-xs text-muted-foreground mt-1">{byStatus.ACTIVE} active</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Task Completion</p>
          <p className="text-3xl font-bold mt-1">{completionRate}%</p>
          <p className="text-xs text-muted-foreground mt-1">{tasksByStatus.COMPLETED}/{allTasks.length} done</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Avg Utilization</p>
          <p className="text-3xl font-bold mt-1">{avgUtilization}%</p>
          <p className="text-xs text-muted-foreground mt-1">{resources.filter(r => r.isOverloaded).length} overloaded</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Team Size</p>
          <p className="text-3xl font-bold mt-1">{resources.length}</p>
          <p className="text-xs text-muted-foreground mt-1">{resources.filter(r => r.activeTasks > 0).length} active</p>
        </CardContent></Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-blue-500" /> Project Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(byStatus).map(([status, count]) => (
              <div key={status} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{status.replace('_', ' ')}</span>
                  <span className="font-medium">{count}</span>
                </div>
                <Progress value={projects.length ? (count / projects.length) * 100 : 0} className="h-1.5" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Target className="h-4 w-4 text-green-500" /> Task Distribution
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(tasksByStatus).map(([status, count]) => (
              <div key={status} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{status.replace('_', ' ')}</span>
                  <span className="font-medium">{count}</span>
                </div>
                <Progress value={allTasks.length ? (count / allTasks.length) * 100 : 0} className="h-1.5" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Project Types</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {Object.entries(byType).map(([type, count]) => (
              <div key={type} className="flex items-center gap-4">
                <div className="w-24 text-sm text-muted-foreground">{type}</div>
                <Progress value={projects.length ? (count / projects.length) * 100 : 0} className="flex-1 h-3" />
                <div className="w-10 text-right text-sm font-medium">{count}</div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-purple-500" /> Resource Utilization
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {resources.slice(0, 8).map(r => (
              <div key={r.id} className="flex items-center gap-3">
                <span className="text-sm w-28 truncate text-muted-foreground">{r.name.split(' ')[0]}</span>
                <Progress
                  value={r.utilizationPct}
                  className={`flex-1 h-2 ${r.isOverloaded ? '[&>div]:bg-red-500' : r.utilizationPct > 70 ? '[&>div]:bg-orange-500' : '[&>div]:bg-green-500'}`}
                />
                <span className={`text-xs w-8 text-right font-medium ${r.isOverloaded ? 'text-red-600' : ''}`}>
                  {r.utilizationPct}%
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
