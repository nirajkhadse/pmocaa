'use client'

import { useEffect, useState } from 'react'
import { useAuthStore } from '@/store/auth'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Eye, EyeOff, KeyRound, CheckCircle2, Bell, BellOff, LifeBuoy, ExternalLink, ClipboardList } from 'lucide-react'

const NOTIF_PREF_KEY = 'pmo-notif-enabled'
const TICKET_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSckMABzfJh04w1zj-IPsMOQxUV5Vtv7__n7bytikaXGMK-N_A/viewform'
const TICKET_STATUS_URL = 'https://docs.google.com/spreadsheets/d/1pSdc4SaOho7iiFgn5NCwiZ4-t1MGo_IWEKiX5aJmeAo/edit?gid=2070436635#gid=2070436635'

export default function SettingsPage() {
  const { user, setUser } = useAuthStore()

  const [currentPwd,  setCurrentPwd]  = useState('')
  const [newPwd,      setNewPwd]      = useState('')
  const [confirmPwd,  setConfirmPwd]  = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew,     setShowNew]     = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [saving,      setSaving]      = useState(false)
  const [done,        setDone]        = useState(false)

  // Notification preference state
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | 'unsupported' | null>(null)
  const [notifEnabled,    setNotifEnabled]    = useState(true)

  useEffect(() => {
    if (typeof Notification === 'undefined') {
      setNotifPermission('unsupported')
    } else {
      setNotifPermission(Notification.permission)
    }
    const stored = localStorage.getItem(NOTIF_PREF_KEY)
    setNotifEnabled(stored !== 'false')
  }, [])

  async function requestNotifPermission() {
    if (typeof Notification === 'undefined') return
    const result = await Notification.requestPermission()
    setNotifPermission(result)
    if (result === 'granted') {
      localStorage.setItem(NOTIF_PREF_KEY, 'true')
      setNotifEnabled(true)
      toast.success('Desktop notifications enabled')
    }
  }

  function toggleNotifEnabled() {
    const next = !notifEnabled
    setNotifEnabled(next)
    localStorage.setItem(NOTIF_PREF_KEY, String(next))
    toast.success(next ? 'Desktop notifications enabled' : 'Desktop notifications disabled')
  }

  const mismatch = newPwd && confirmPwd && newPwd !== confirmPwd
  const tooShort = newPwd.length > 0 && newPwd.length < 6
  const canSubmit = currentPwd.length > 0 && newPwd.length >= 6 && newPwd === confirmPwd && !saving

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPwd, newPassword: newPwd }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setDone(true)
      setCurrentPwd(''); setNewPwd(''); setConfirmPwd('')
      // Clear the force-change flag from the local store so banner disappears
      if (user) setUser({ ...user, mustChangePassword: false })
      toast.success('Password changed successfully')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to change password')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground text-sm">Manage your account preferences</p>
      </div>

      {user?.mustChangePassword && (
        <div className="bg-orange-50 dark:bg-orange-950 border border-orange-200 dark:border-orange-800 rounded-lg p-3 text-sm text-orange-700 dark:text-orange-300">
          An administrator has reset your password. You must set a new password before you can continue using the app.
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-blue-500" /> Change Password
          </CardTitle>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="flex flex-col items-center py-6 gap-3 text-center">
              <CheckCircle2 className="h-10 w-10 text-green-500" />
              <p className="font-medium">Password changed successfully</p>
              <p className="text-sm text-muted-foreground">Your new password is active.</p>
              <Button variant="outline" size="sm" onClick={() => setDone(false)}>Change again</Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label>Current Password *</Label>
                <div className="relative">
                  <Input
                    type={showCurrent ? 'text' : 'password'}
                    placeholder="Your current password"
                    value={currentPwd}
                    onChange={e => setCurrentPwd(e.target.value)}
                    className="pr-9"
                    autoComplete="current-password"
                  />
                  <button type="button" onClick={() => setShowCurrent(s => !s)}
                    className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground">
                    {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>New Password *</Label>
                <div className="relative">
                  <Input
                    type={showNew ? 'text' : 'password'}
                    placeholder="At least 6 characters"
                    value={newPwd}
                    onChange={e => setNewPwd(e.target.value)}
                    className="pr-9"
                    autoComplete="new-password"
                  />
                  <button type="button" onClick={() => setShowNew(s => !s)}
                    className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground">
                    {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {tooShort && <p className="text-red-500 text-xs">Password must be at least 6 characters</p>}
              </div>

              <div className="space-y-1.5">
                <Label>Confirm New Password *</Label>
                <div className="relative">
                  <Input
                    type={showConfirm ? 'text' : 'password'}
                    placeholder="Repeat new password"
                    value={confirmPwd}
                    onChange={e => setConfirmPwd(e.target.value)}
                    className="pr-9"
                    autoComplete="new-password"
                  />
                  <button type="button" onClick={() => setShowConfirm(s => !s)}
                    className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground">
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {mismatch && <p className="text-red-500 text-xs">Passwords do not match</p>}
              </div>

              <Button type="submit" disabled={!canSubmit} className="w-full">
                {saving ? 'Saving…' : 'Change Password'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4 text-blue-500" /> Desktop Notifications
          </CardTitle>
        </CardHeader>
        <CardContent>
          {notifPermission === null && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}

          {notifPermission === 'unsupported' && (
            <p className="text-sm text-muted-foreground">Your browser does not support desktop notifications.</p>
          )}

          {notifPermission === 'default' && (
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Enable desktop notifications</p>
                <p className="text-xs text-muted-foreground mt-0.5">Get alerted when new notifications arrive, even when the tab is in the background.</p>
              </div>
              <Button size="sm" onClick={requestNotifPermission} className="shrink-0">Enable</Button>
            </div>
          )}

          {notifPermission === 'granted' && (
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  {notifEnabled ? <Bell className="h-4 w-4 text-green-500" /> : <BellOff className="h-4 w-4 text-muted-foreground" />}
                  {notifEnabled ? 'Notifications are on' : 'Notifications are off'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {notifEnabled
                    ? 'You will receive desktop alerts when new notifications arrive while this tab is in the background.'
                    : 'Desktop alerts are currently disabled. Turn them on to get alerted in the background.'}
                </p>
              </div>
              <button
                onClick={toggleNotifEnabled}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none ${
                  notifEnabled ? 'bg-blue-600' : 'bg-muted-foreground/30'
                }`}
                aria-label={notifEnabled ? 'Disable notifications' : 'Enable notifications'}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  notifEnabled ? 'translate-x-6' : 'translate-x-1'
                }`} />
              </button>
            </div>
          )}

          {notifPermission === 'denied' && (
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <BellOff className="h-4 w-4" /> Notifications are blocked by the browser
              </p>
              <p className="text-xs text-muted-foreground">
                To enable, click the lock / info icon in your browser&apos;s address bar and set Notifications to <strong>Allow</strong>, then reload the page.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <LifeBuoy className="h-4 w-4 text-blue-500" /> Support & Tickets
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Raise a ticket</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Report an issue or submit a request using the ticket form.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              nativeButton={false}
              render={<a href={TICKET_FORM_URL} target="_blank" rel="noopener noreferrer" />}
            >
              Open form <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-muted-foreground" /> Track ticket status
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Check the status of tickets you&apos;ve raised.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              nativeButton={false}
              render={<a href={TICKET_STATUS_URL} target="_blank" rel="noopener noreferrer" />}
            >
              View status <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>

    </div>
  )
}
