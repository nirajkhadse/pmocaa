'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ClipboardCheck, Clock, Calendar, Check, Users } from 'lucide-react'

interface User {
  id: string; name: string; role: string; capacityPct: number
  department?: string; title?: string
}

interface AssignWorkDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  prefillUserId?: string
  prefillName?: string
  onAssigned?: () => void
}

const ROLE_COLORS: Record<string, string> = {
  ADMIN: 'bg-red-100 text-red-700', MANAGER: 'bg-purple-100 text-purple-700',
  PLANNER: 'bg-blue-100 text-blue-700', PROJECT_LEAD: 'bg-green-100 text-green-700',
  WORKSTREAM_LEAD: 'bg-teal-100 text-teal-700', RESOURCE: 'bg-slate-100 text-slate-700',
  LEADERSHIP: 'bg-orange-100 text-orange-700',
}
const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin', MANAGER: 'Manager', PLANNER: 'Planner',
  PROJECT_LEAD: 'Project Lead', WORKSTREAM_LEAD: 'Workstream Lead',
  RESOURCE: 'Engineer / Analyst', LEADERSHIP: 'Leadership',
}

export function AssignWorkDialog({ open, onOpenChange, prefillUserId, prefillName, onAssigned }: AssignWorkDialogProps) {
  const [users,       setUsers]       = useState<User[]>([])
  const [submitting,  setSubmitting]  = useState(false)

  const [title,           setTitle]           = useState('')
  const [description,     setDescription]     = useState('')
  const [assigneeIds,     setAssigneeIds]     = useState<string[]>(prefillUserId ? [prefillUserId] : [])
  const [estimatedHours,  setEstimatedHours]  = useState('')
  const [startDate,       setStartDate]       = useState('')
  const [endDate,         setEndDate]         = useState('')
  const [priority,        setPriority]        = useState('MEDIUM')

  useEffect(() => {
    if (!open) return
    fetch('/api/users').then(r => r.json()).then(d => setUsers(Array.isArray(d) ? d.filter((u: User & { isActive: boolean }) => u.isActive) : []))
  }, [open])

  useEffect(() => {
    if (prefillUserId) setAssigneeIds([prefillUserId])
  }, [prefillUserId])

  async function submit() {
    if (!title.trim()) { toast.error('Task title is required'); return }
    if (assigneeIds.length === 0) { toast.error('Please select at least one assignee'); return }
    if (!endDate)      { toast.error('Due date is required'); return }

    setSubmitting(true)
    try {
      const res = await fetch('/api/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: title, description, ownerIds: assigneeIds, estimatedHours: estimatedHours || null, startDate: startDate || null, endDate, priority }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Failed')
      toast.success(`Work assigned to ${assigneeIds.length} ${assigneeIds.length === 1 ? 'person' : 'people'}`)
      setTitle(''); setDescription(''); setEstimatedHours(''); setStartDate(''); setEndDate(''); setPriority('MEDIUM')
      if (!prefillUserId) setAssigneeIds([])
      onOpenChange(false)
      onAssigned?.()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to assign')
    } finally { setSubmitting(false) }
  }

  const selectedUsers = users.filter(u => assigneeIds.includes(u.id))
  const selected = selectedUsers[0]
  const hoursPerPerson = estimatedHours && assigneeIds.length > 0
    ? parseFloat(estimatedHours) / assigneeIds.length
    : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-blue-600" />
            Assign Work
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Assignee picker */}
          <div className="space-y-1.5">
            <Label>Assign to * <span className="font-normal text-muted-foreground">(select one or more)</span></Label>
            {prefillUserId && prefillName ? (
              <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="text-xs">{prefillName.split(' ').map(n=>n[0]).join('').slice(0,2)}</AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium">{prefillName}</span>
              </div>
            ) : (
              <Select value="" onValueChange={(v) => { const s = v as string | null; if (s) setAssigneeIds((previous) => previous.includes(s) ? previous : [...previous, s]) }}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick a team member…" />
                </SelectTrigger>
                <SelectContent>
                  {users.map(u => (
                    <SelectItem key={u.id} value={u.id}>
                      <span className="flex items-center gap-2">
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ROLE_COLORS[u.role] ?? ''}`}>
                          {ROLE_LABELS[u.role] ?? u.role}
                        </span>
                        {u.name}
                        {u.department && <span className="text-muted-foreground text-xs">· {u.department}</span>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {!prefillUserId && selectedUsers.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedUsers.map((person) => (
                  <button key={person.id} type="button" onClick={() => setAssigneeIds((previous) => previous.filter((id) => id !== person.id))}
                    className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                    <Check className="h-3 w-3" /> {person.name} <span aria-hidden>×</span>
                  </button>
                ))}
              </div>
            )}
            {selectedUsers.length > 0 && !prefillUserId && (
              <p className="text-xs text-muted-foreground">
                {ROLE_LABELS[selected.role]} · {selected.capacityPct}% capacity
                {selected.title && ` · ${selected.title}`}
              </p>
            )}
          </div>

          {/* Task name */}
          <div className="space-y-1.5">
            <Label>Task / Work Title *</Label>
            <Input placeholder="e.g. Disassemble conveyor belt section B" value={title} onChange={e => setTitle(e.target.value)} />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea placeholder="What needs to be done, acceptance criteria, references…" rows={2}
              value={description} onChange={e => setDescription(e.target.value)} />
          </div>

          {/* Time & dates row */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" /> Est. Hours
              </Label>
              <Input type="number" min="0" step="0.5" placeholder="8"
                value={estimatedHours} onChange={e => setEstimatedHours(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" /> Start Date
              </Label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" /> Due Date *
              </Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>

          {/* Priority */}
          <div className="space-y-1.5">
            <Label>Priority</Label>
            <Select value={priority} onValueChange={(v) => { const s = v as string | null; if (s) setPriority(s) }}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="LOW">Low</SelectItem>
                <SelectItem value="MEDIUM">Medium</SelectItem>
                <SelectItem value="HIGH">High</SelectItem>
                <SelectItem value="CRITICAL">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Summary chip */}
          {estimatedHours && endDate && assigneeIds.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-blue-50 dark:bg-blue-950 rounded-lg px-3 py-2">
              <Users className="h-3.5 w-3.5 text-blue-500" />
              <span><strong>{estimatedHours}h total</strong> · <strong>{hoursPerPerson.toFixed(2)}h each</strong> across {assigneeIds.length} {assigneeIds.length === 1 ? 'person' : 'people'} · due <strong>{new Date(endDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</strong></span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} disabled={submitting} className="bg-blue-600 hover:bg-blue-700">
              <ClipboardCheck className="mr-1.5 h-4 w-4" />
              {submitting ? 'Assigning…' : 'Assign Work'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
