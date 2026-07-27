import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth'

export const HOURS_PER_DAY = 8   // daily limit per person (at 100% capacity)
export const HOURS_PER_WEEK = 40  // weekly limit per person (at 100% capacity)

function parseMeetingHours(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(':').map(Number)
  const [eh, em] = endTime.split(':').map(Number)
  return Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60)
}

export function getWeekBounds() {
  const now = new Date()
  const dayOfWeek = now.getDay()
  const daysToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() + daysToMon)
  weekStart.setHours(0, 0, 0, 0)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 6)
  weekEnd.setHours(23, 59, 59, 999)
  return { weekStart, weekEnd }
}

// Count working (Mon–Fri) days between two dates inclusive
function countWorkingDays(start: Date, end: Date): number {
  let count = 0
  const curr = new Date(start)
  curr.setHours(0, 0, 0, 0)
  const endDay = new Date(end)
  endDay.setHours(23, 59, 59, 999)
  while (curr <= endDay) {
    const dow = curr.getDay()
    if (dow !== 0 && dow !== 6) count++
    curr.setDate(curr.getDate() + 1)
  }
  return Math.max(1, count)
}

// Returns regular + delayed daily hours for COMPLETED tasks.
// Regular = days within the originally planned endDate.
// Delayed = days after endDate but before statusChangedAt (actual finish).
function calcCompletedHours(
  tasks: Array<{
    estimatedHours: number | null
    effortHours: number
    createdAt: Date
    startDate: Date | null
    endDate: Date | null
    statusChangedAt: Date | null
  }>,
  rangeStart: Date,
  rangeEnd: Date
): { regular: Record<string, number>; delayed: Record<string, number> } {
  const regular: Record<string, number> = {}
  const delayed: Record<string, number> = {}
  for (const task of tasks) {
    if (!task.statusChangedAt) continue
    // Completion must not free hours already worked on the same day. Keep the
    // larger of planned work and logged effort, matching active-task handling.
    const hrs = Math.max(task.estimatedHours ?? 0, task.effortHours ?? 0)
    if (hrs === 0) continue
    // Work window = startDate → statusChangedAt (the actual time span)
    // If no schedule start was supplied, use the actual assignment/creation time.
    // The old seven-day fallback made a task assigned and completed today retain
    // only a small fraction of its hours, falsely freeing utilization immediately.
    const workStart = task.startDate ?? task.createdAt
    const workEnd   = task.statusChangedAt
    const overlapStart = new Date(Math.max(workStart.getTime(), rangeStart.getTime()))
    const overlapEnd   = new Date(Math.min(workEnd.getTime(),   rangeEnd.getTime()))
    if (overlapStart > overlapEnd) continue
    const totalDays = countWorkingDays(workStart, workEnd)
    const hpd = hrs / totalDays
    const curr = new Date(overlapStart)
    curr.setHours(0, 0, 0, 0)
    while (curr <= overlapEnd) {
      const dow = curr.getDay()
      if (dow !== 0 && dow !== 6) {
        const key = curr.toISOString().slice(0, 10)
        // Day is "delayed" if it falls after the original planned endDate
        if (task.endDate && curr > task.endDate) {
          delayed[key] = (delayed[key] ?? 0) + hpd
        } else {
          regular[key] = (regular[key] ?? 0) + hpd
        }
      }
      curr.setDate(curr.getDate() + 1)
    }
  }
  return { regular, delayed }
}

// Returns a map of ISO-date → hours for every working day in the current week
export function calcDailyHours(
  tasks: Array<{ estimatedHours: number; startDate: Date | null; endDate: Date | null }>,
  weekStart: Date,
  weekEnd: Date
): Record<string, number> {
  const daily: Record<string, number> = {}

  // Pre-populate all Mon–Fri days in the range with 0
  const populateDay = new Date(weekStart)
  populateDay.setHours(0, 0, 0, 0)
  const populateEnd = new Date(weekEnd)
  populateEnd.setHours(23, 59, 59, 999)
  while (populateDay <= populateEnd) {
    const dow = populateDay.getDay()
    if (dow !== 0 && dow !== 6) {
      daily[populateDay.toISOString().slice(0, 10)] = 0
    }
    populateDay.setDate(populateDay.getDate() + 1)
  }

  const workingKeys = Object.keys(daily)

  for (const task of tasks) {
    const hrs = task.estimatedHours || 0
    if (hrs === 0) continue

    if (!task.startDate || !task.endDate) {
      // No dates → spread equally across Mon–Fri of this week
      const hpd = hrs / (workingKeys.length || 5)
      for (const key of workingKeys) daily[key] += hpd
      continue
    }

    // Overlap of task with this week
    const overlapStart = new Date(Math.max(task.startDate.getTime(), weekStart.getTime()))
    const overlapEnd   = new Date(Math.min(task.endDate.getTime(), weekEnd.getTime()))
    if (overlapStart > overlapEnd) continue

    // Rate = estimated hours ÷ total working days of the full task span
    const totalWorkingDays = countWorkingDays(task.startDate, task.endDate)
    const hpd = hrs / totalWorkingDays

    // Distribute into each overlapping working day
    const curr = new Date(overlapStart)
    curr.setHours(0, 0, 0, 0)
    while (curr <= overlapEnd) {
      const dow = curr.getDay()
      if (dow !== 0 && dow !== 6) {
        const key = curr.toISOString().slice(0, 10)
        if (key in daily) daily[key] += hpd
      }
      curr.setDate(curr.getDate() + 1)
    }
  }

  return daily
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth()
    const { searchParams } = new URL(req.url)
    const role = searchParams.get('role')
    const fromParam = searchParams.get('from')
    const toParam   = searchParams.get('to')

    const { weekStart, weekEnd } = getWeekBounds()
    // For gantt requests, use the requested range; otherwise default to current week
    const rangeStart = fromParam ? new Date(fromParam + 'T00:00:00') : weekStart
    const rangeEnd   = toParam   ? new Date(toParam   + 'T23:59:59') : weekEnd

    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        ...(role ? { role: role as never } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatarUrl: true,
        capacityPct: true,
        department: true,
        title: true,
        allocations: {
          include: {
            project: { select: { id: true, name: true, status: true } },
          },
        },
        ownedTasks: {
          where: {
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
            OR: [
              { startDate: null },
              { endDate: null },
              { startDate: { lte: rangeEnd }, endDate: { gte: rangeStart } },
              // Always pull active tasks — overdue IN_PROGRESS/REWORK must count this week
              { status: { in: ['IN_PROGRESS', 'REWORK'] } },
            ],
          },
          select: {
            id: true,
            name: true,
            description: true,
            status: true,
            priority: true,
            effortHours: true,
            estimatedHours: true,
            pctComplete: true,
            startDate: true,
            endDate: true,
            assignedBy: { select: { id: true, name: true } },
            workstream: {
              select: {
                id: true,
                name: true,
                project: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: [{ endDate: 'asc' }, { priority: 'asc' }],
        },
        assignedRequests: {
          where: { status: { in: ['SUBMITTED', 'REVIEW', 'APPROVED'] } },
          select: {
            id: true,
            title: true,
            status: true,
            estimatedHours: true,
            hoursPerDay: true,
            isRecurring: true,
            startDate: true,
            endDate: true,
          },
        },
        leaves: {
          where: {
            endDate:   { gte: rangeStart },
            startDate: { lte: rangeEnd },
          },
          select: { startDate: true, endDate: true },
        },
      },
      orderBy: { name: 'asc' },
    })

    // Completed tasks in the last 60 days — hours spread over actual work window
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    const completedTasksAll = await prisma.task.findMany({
      where: {
        status: 'COMPLETED',
        ownerId: { in: users.map(u => u.id) },
        statusChangedAt: { gte: sixtyDaysAgo },
      },
      select: {
        id: true,
        name: true,
        priority: true,
        estimatedHours: true,
        effortHours: true,
        createdAt: true,
        startDate: true,
        endDate: true,
        statusChangedAt: true,
        ownerId: true,
        workstream: { select: { id: true, name: true, project: { select: { id: true, name: true } } } },
      },
    })
    const completedByUser = new Map<string, typeof completedTasksAll>()
    for (const ct of completedTasksAll) {
      if (!ct.ownerId) continue
      if (!completedByUser.has(ct.ownerId)) completedByUser.set(ct.ownerId, [])
      completedByUser.get(ct.ownerId)!.push(ct)
    }

    // Strategic tasks for all active users (counted in utilization + shown in detail)
    const strategicTasksAll = await prisma.strategicTask.findMany({
      where: { assigneeId: { in: users.map(u => u.id) } },
      select: {
        id: true,
        title: true,
        status: true,
        assigneeId: true,
        estimatedHours: true,
        hoursPerDay: true,
        isRecurring: true,
        startDate: true,
        endDate: true,
        strategicRequest: { select: { id: true, title: true } },
      },
    })
    const strategicByUser = new Map<string, typeof strategicTasksAll>()
    for (const st of strategicTasksAll) {
      if (!st.assigneeId) continue
      if (!strategicByUser.has(st.assigneeId)) strategicByUser.set(st.assigneeId, [])
      strategicByUser.get(st.assigneeId)!.push(st)
    }

    // Meetings within the requested range — their hours count toward utilization
    const meetingsAll = await prisma.meeting.findMany({
      where: {
        userId: { in: users.map(u => u.id) },
        date: { gte: rangeStart, lte: rangeEnd },
      },
      select: { id: true, userId: true, title: true, date: true, startTime: true, endTime: true },
    })
    const meetingsByUser = new Map<string, typeof meetingsAll>()
    for (const m of meetingsAll) {
      if (!meetingsByUser.has(m.userId)) meetingsByUser.set(m.userId, [])
      meetingsByUser.get(m.userId)!.push(m)
    }

    // Meetings within the current week (needed separately for gantt requests)
    const weekMeetingsAll = (fromParam || toParam)
      ? await prisma.meeting.findMany({
          where: {
            userId: { in: users.map(u => u.id) },
            date: { gte: weekStart, lte: weekEnd },
          },
          select: { id: true, userId: true, title: true, date: true, startTime: true, endTime: true },
        })
      : meetingsAll
    const weekMeetingsByUser = new Map<string, typeof weekMeetingsAll>()
    for (const m of weekMeetingsAll) {
      if (!weekMeetingsByUser.has(m.userId)) weekMeetingsByUser.set(m.userId, [])
      weekMeetingsByUser.get(m.userId)!.push(m)
    }

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const withUtilization = users.map((user) => {
      // Limits scaled by this person's capacity setting
      const weeklyCapacityHours = Math.round(HOURS_PER_WEEK * user.capacityPct / 100 * 10) / 10
      const dailyCapacityHours  = Math.round(HOURS_PER_DAY  * user.capacityPct / 100 * 10) / 10

      // REVIEW requests count toward utilization (manager is actively processing — very likely approved).
      // SUBMITTED requests (self-submitted, unreviewed) are display-only — too uncertain to count.
      // APPROVED requests already exist as Tasks in ownedTasks, so no need to include here.
      const toWorkItem = (req: typeof user.assignedRequests[number]) => {
        if (req.isRecurring && req.hoursPerDay) {
          const start = req.startDate ?? new Date()
          const end   = req.endDate   ?? new Date(start.getTime() + 90 * 24 * 60 * 60 * 1000)
          return { estimatedHours: req.hoursPerDay * countWorkingDays(start, end), startDate: req.startDate, endDate: end }
        }
        return { estimatedHours: req.estimatedHours ?? 0, startDate: req.startDate, endDate: req.endDate }
      }

      const reviewRequestItems = user.assignedRequests
        .filter(r => r.status === 'REVIEW')
        .map(toWorkItem)

      const pendingRequestItems = user.assignedRequests.map(toWorkItem)

      // If an approved request has no generated task (legacy data or a failed
      // conversion), count the request itself so approval still affects load.
      const materializedDirectTaskNames = new Set(
        user.ownedTasks
          .filter(t => t.workstream.project.name === '__direct_assignments__')
          .map(t => t.name.trim().toLowerCase())
      )
      const unmaterializedApprovedItems = user.assignedRequests
        .filter(r =>
          r.status === 'APPROVED' &&
          !materializedDirectTaskNames.has(r.title.trim().toLowerCase())
        )
        .map(toWorkItem)

      // Completed/cancelled strategic work no longer reserves capacity.
      const activeStrategicTasks = (strategicByUser.get(user.id) ?? []).filter(st =>
        !['COMPLETED', 'CANCELLED'].includes((st.status ?? '').toUpperCase())
      )
      const userStrategicItems = activeStrategicTasks.map(st => {
        let estimatedHours: number
        if (st.isRecurring && st.hoursPerDay) {
          const s = st.startDate ?? new Date()
          const e = st.endDate ?? new Date(s.getTime() + 90 * 24 * 60 * 60 * 1000)
          estimatedHours = st.hoursPerDay * countWorkingDays(s, e)
        } else {
          estimatedHours = st.estimatedHours ?? 0
        }
        return { estimatedHours, startDate: st.startDate, endDate: st.endDate }
      })

      // Logged effort is cumulative rather than date-stamped. Use it when it
      // exceeds the estimate so overruns update utilization without counting
      // planned and actual hours twice.
      const ownedWorkItems = user.ownedTasks.map(t => ({
        ...t,
        estimatedHours: Math.max(t.estimatedHours || 0, t.effortHours || 0),
      }))

      const allWorkItems = [
        ...ownedWorkItems,
        ...reviewRequestItems,
        ...unmaterializedApprovedItems,
        ...userStrategicItems,
      ]

      // For weekly utilization: overdue IN_PROGRESS/REWORK tasks (endDate before this week) get their
      // dates nulled so calcDailyHours spreads their hours across the current week instead of skipping them.
      const weeklyTasks = ownedWorkItems.map((t) =>
        (t.status === 'IN_PROGRESS' || t.status === 'REWORK') &&
        t.endDate && new Date(t.endDate) < weekStart
          ? { ...t, startDate: null as Date | null, endDate: null as Date | null }
          : t
      )
      const weeklyWorkItems = [
        ...weeklyTasks,
        ...reviewRequestItems,
        ...unmaterializedApprovedItems,
        ...userStrategicItems,
      ]

      // dailyHoursMap covers the requested range (gantt) or current week (default)
      const dailyHoursMap = calcDailyHours(
        fromParam || toParam ? allWorkItems : weeklyWorkItems,
        rangeStart,
        rangeEnd
      )

      // Merge completed task hours into dailyHoursMap (actual work window, capped at statusChangedAt)
      const userCompletedTasks = completedByUser.get(user.id) ?? []
      const { regular: cmpR, delayed: cmpD } = calcCompletedHours(userCompletedTasks, rangeStart, rangeEnd)
      for (const [date, h] of Object.entries(cmpR)) dailyHoursMap[date] = (dailyHoursMap[date] ?? 0) + h
      const delayedDailyHoursMap: Record<string, number> = {}
      for (const [date, h] of Object.entries(cmpD)) {
        delayedDailyHoursMap[date] = h
        dailyHoursMap[date] = (dailyHoursMap[date] ?? 0) + h
      }

      // Merge meeting hours into dailyHoursMap
      const userMeetings = meetingsByUser.get(user.id) ?? []
      for (const m of userMeetings) {
        const dateKey = new Date(m.date).toISOString().slice(0, 10)
        const hrs = parseMeetingHours(m.startTime, m.endTime)
        dailyHoursMap[dateKey] = (dailyHoursMap[dateKey] ?? 0) + hrs
      }

      // Weekly stats always reflect the current week regardless of gantt range
      let currentWeekMap: Record<string, number>
      if (fromParam || toParam) {
        currentWeekMap = calcDailyHours(weeklyWorkItems, weekStart, weekEnd)
        const { regular: cwR, delayed: cwD } = calcCompletedHours(userCompletedTasks, weekStart, weekEnd)
        for (const [date, h] of Object.entries(cwR)) currentWeekMap[date] = (currentWeekMap[date] ?? 0) + h
        for (const [date, h] of Object.entries(cwD)) currentWeekMap[date] = (currentWeekMap[date] ?? 0) + h
        // Merge this week's meeting hours into currentWeekMap (gantt path)
        const userWeekMeetings = weekMeetingsByUser.get(user.id) ?? []
        for (const m of userWeekMeetings) {
          const dateKey = new Date(m.date).toISOString().slice(0, 10)
          const hrs = parseMeetingHours(m.startTime, m.endTime)
          currentWeekMap[dateKey] = (currentWeekMap[dateKey] ?? 0) + hrs
        }
      } else {
        currentWeekMap = dailyHoursMap
      }
      const dailyValues = Object.values(currentWeekMap)

      const thisWeekHours = Math.round(dailyValues.reduce((s, h) => s + h, 0) * 10) / 10
      const maxDailyHours = Math.round(Math.max(0, ...dailyValues) * 10) / 10

      const utilizationPct = weeklyCapacityHours > 0
        ? Math.round(thisWeekHours / weeklyCapacityHours * 100)
        : 0

      const isOverloadedWeekly = thisWeekHours > weeklyCapacityHours
      const isOverloadedDaily  = maxDailyHours  > dailyCapacityHours
      const isOverloaded       = isOverloadedWeekly || isOverloadedDaily

      const overloadReason = isOverloadedDaily && isOverloadedWeekly
        ? 'both'
        : isOverloadedDaily  ? 'daily'
        : isOverloadedWeekly ? 'weekly'
        : null

      const strategicTaskHours = Math.round(
        userStrategicItems.reduce((s, t) => s + (t.estimatedHours || 0), 0) * 10
      ) / 10

      const totalTaskHours = Math.round(
        (ownedWorkItems.reduce((s, t) => s + (t.estimatedHours || 0), 0) + strategicTaskHours) * 10
      ) / 10

      const directTaskHours = Math.round(
        user.ownedTasks
          .filter(t => t.workstream.project.name === '__direct_assignments__')
          .reduce((s, t) => s + (t.estimatedHours || 0), 0) * 10
      ) / 10

      // reviewRequestHours: counted in utilization (REVIEW status — manager is processing)
      const reviewRequestHours = Math.round(
        reviewRequestItems.reduce((s, r) => s + (r.estimatedHours || 0), 0) * 10
      ) / 10

      // submittedRequestHours: display-only (SUBMITTED — not yet reviewed, too uncertain)
      const pendingRequestHours = Math.round(
        pendingRequestItems
          .filter((_, i) => user.assignedRequests[i]?.status === 'SUBMITTED')
          .reduce((s, r) => s + (r.estimatedHours || 0), 0) * 10
      ) / 10

      // Leave days (working days within the requested range where user is on leave)
      const leaveDates: string[] = []
      for (const leave of user.leaves) {
        const ls = new Date(leave.startDate); ls.setHours(0, 0, 0, 0)
        const le = new Date(leave.endDate);   le.setHours(23, 59, 59, 999)
        const start = new Date(Math.max(ls.getTime(), rangeStart.getTime()))
        const end   = new Date(Math.min(le.getTime(), rangeEnd.getTime()))
        const curr  = new Date(start); curr.setHours(0, 0, 0, 0)
        while (curr <= end) {
          const dow = curr.getDay()
          if (dow !== 0 && dow !== 6) leaveDates.push(curr.toISOString().slice(0, 10))
          curr.setDate(curr.getDate() + 1)
        }
      }

      const isOnLeaveToday = user.leaves.some(l => {
        const ls = new Date(l.startDate); ls.setHours(0, 0, 0, 0)
        const le = new Date(l.endDate);   le.setHours(23, 59, 59, 999)
        return today >= ls && today <= le
      })

      return {
        ...user,
        // Hours
        thisWeekHours,
        maxDailyHours,
        weeklyCapacityHours,
        dailyCapacityHours,
        totalTaskHours,
        directTaskHours,
        reviewRequestHours,
        pendingRequestHours,
        meetingHours: Math.round(userMeetings.reduce((s, m) => s + parseMeetingHours(m.startTime, m.endTime), 0) * 10) / 10,
        meetings: userMeetings.map(m => ({
          id: m.id,
          title: m.title,
          date: new Date(m.date).toISOString().slice(0, 10),
          startTime: m.startTime,
          endTime: m.endTime,
          hours: parseMeetingHours(m.startTime, m.endTime),
        })),
        dailyHoursMap,
        delayedDailyHoursMap,
        // Utilization
        utilizationPct,
        // Overload flags
        isOverloaded,
        isOverloadedWeekly,
        isOverloadedDaily,
        overloadReason,
        activeTasks: user.ownedTasks.length + activeStrategicTasks.length,
        // Leave
        leaveDates,
        isOnLeaveToday,
        // Strategic tasks for detail dialog
        strategicTasks: (strategicByUser.get(user.id) ?? []).map(st => {
          let estimatedHours: number
          if (st.isRecurring && st.hoursPerDay) {
            const s = st.startDate ?? new Date()
            const e = st.endDate ?? new Date(s.getTime() + 90 * 24 * 60 * 60 * 1000)
            estimatedHours = st.hoursPerDay * countWorkingDays(s, e)
          } else {
            estimatedHours = st.estimatedHours ?? 0
          }
          return {
            id: st.id,
            name: st.title,
            requestTitle: st.strategicRequest.title,
            status: st.status ?? 'PLANNED',
            estimatedHours,
            startDate: st.startDate?.toISOString() ?? null,
            endDate: st.endDate?.toISOString() ?? null,
          }
        }),
        // Completed tasks (last 60 days) for detail dialog badges
        completedTasks: userCompletedTasks.map(ct => ({
          id: ct.id,
          name: ct.name,
          priority: ct.priority,
          estimatedHours: ct.estimatedHours ?? 0,
          startDate: ct.startDate?.toISOString() ?? null,
          endDate: ct.endDate?.toISOString() ?? null,
          statusChangedAt: ct.statusChangedAt?.toISOString() ?? null,
          workstream: ct.workstream,
        })),
      }
    })

    return Response.json(withUtilization, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
