'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuthStore } from '@/store/auth'
import { SidebarNav } from '@/components/layout/sidebar-nav'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { BarChart3, Bell, Menu, X } from 'lucide-react'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { user, setUser } = useAuthStore()
  const [unreadCount,          setUnreadCount]          = useState(0)
  const [pendingRequestsCount, setPendingRequestsCount] = useState(0)
  const [checking,    setChecking]    = useState(true)
  const [mobileOpen,  setMobileOpen]  = useState(false)
  const [notifPermission,      setNotifPermission]      = useState<NotificationPermission | 'unsupported' | null>(null)
  const [notifBannerDismissed, setNotifBannerDismissed] = useState(false)
  const prevUnreadRef = useRef<number | null>(null)
  const countsInFlightRef = useRef(false)

  // Check notification API support and current permission
  useEffect(() => {
    if (typeof Notification === 'undefined') {
      setNotifPermission('unsupported')
    } else {
      setNotifPermission(Notification.permission)
    }
  }, [])

  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/me', {
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) {
          setUser(null)
          router.push('/login')
          return
        }
        const { user: u } = await res.json()
        setUser(u)
      } catch {
        router.push('/login')
      } finally {
        setChecking(false)
      }
    }
    checkAuth()
  }, [])

  useEffect(() => {
    if (!user) return
    const fetchCounts = async () => {
      if (countsInFlightRef.current) return
      countsInFlightRef.current = true
      try {
        const res = await fetch('/api/notifications?unread=true', {
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        })
        if (res.ok) {
          const data = await res.json()
          const newCount: number = data.unreadCount || 0
          const notifs: Array<{ title: string; message: string }> = data.notifications ?? []
          // Fire desktop notification for newly arrived notifications when tab is hidden
          if (
            prevUnreadRef.current !== null &&
            newCount > prevUnreadRef.current &&
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted' &&
            localStorage.getItem('pmo-notif-enabled') !== 'false' &&
            document.visibilityState === 'hidden'
          ) {
            const diff = newCount - prevUnreadRef.current
            const latest = notifs[0]
            const notifTitle = latest?.title ?? 'New notification'
            const bodyParts = [
              latest?.message,
              diff > 1 ? `+${diff - 1} more` : null,
              `${newCount} unread`,
            ].filter(Boolean)
            const n = new Notification(notifTitle, {
              body: bodyParts.join(' · '),
              icon: '/favicon.ico',
            })
            setTimeout(() => n.close(), 20000)
          }
          prevUnreadRef.current = newCount
          setUnreadCount(newCount)
        }
        if (['ADMIN', 'MANAGER', 'PLANNER'].includes(user.role)) {
          const res = await fetch('/api/requests?status=SUBMITTED', {
            cache: 'no-store',
            signal: AbortSignal.timeout(15_000),
          })
          if (res.ok) {
            const data = await res.json()
            setPendingRequestsCount(Array.isArray(data) ? data.length : 0)
          }
        }
      } catch {
        // Keep the last good badge counts during a temporary DB/network issue.
      } finally {
        countsInFlightRef.current = false
      }
    }
    fetchCounts()
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') fetchCounts()
    }, 60000)
    return () => clearInterval(interval)
  }, [user])

  async function requestNotifPermission() {
    if (typeof Notification === 'undefined') return
    const result = await Notification.requestPermission()
    setNotifPermission(result)
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center space-y-4">
          <div className="relative">
            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center">
              <BarChart3 className="h-6 w-6 text-white" />
            </div>
            <div className="absolute -inset-1 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 opacity-30 blur animate-pulse" />
          </div>
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-muted-foreground text-sm">Loading PMO Portal…</p>
        </div>
      </div>
    )
  }

  if (!user) return null

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <SidebarNav
        unreadCount={unreadCount}
        pendingRequestsCount={pendingRequestsCount}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      {/* Main content column */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Mobile top bar */}
        <header className="lg:hidden flex items-center h-14 px-4 border-b border-border bg-sidebar shrink-0 gap-3">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 rounded-lg text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center">
              <BarChart3 className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="font-bold text-sidebar-foreground text-sm tracking-tight">PMO Portal</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        </header>

        {/* Desktop notifications prompt — shown once until enabled or dismissed */}
        {notifPermission === 'default' && !notifBannerDismissed && (
          <div className="shrink-0 bg-blue-50 dark:bg-blue-950/60 border-b border-blue-200 dark:border-blue-800 px-4 py-2 flex items-center gap-3 text-sm text-blue-700 dark:text-blue-300">
            <Bell className="h-4 w-4 shrink-0" />
            <span>Get desktop alerts when new notifications arrive</span>
            <button
              onClick={requestNotifPermission}
              className="ml-auto text-xs font-semibold px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 shrink-0"
            >
              Enable
            </button>
            <button onClick={() => setNotifBannerDismissed(true)} className="text-blue-400 hover:text-blue-600 shrink-0">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Password-reset alert */}
        {user?.mustChangePassword && (
          <div className="shrink-0 bg-orange-50 dark:bg-orange-950 border-b border-orange-200 dark:border-orange-800 px-4 py-2 flex items-center gap-3 text-sm text-orange-700 dark:text-orange-300">
            <span className="font-medium">Action required:</span>
            <span>Your password has been reset by an administrator.</span>
            <Link
              href="/settings"
              className="ml-auto underline underline-offset-2 font-medium hover:text-orange-900 dark:hover:text-orange-100 shrink-0"
            >
              Set a new password →
            </Link>
          </div>
        )}

        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
