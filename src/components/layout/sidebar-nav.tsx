'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth'
import { toast } from 'sonner'
import {
  LayoutDashboard,
  FolderKanban,
  Users,
  ClipboardList,
  GitBranch,
  Bell,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  BarChart3,
  FileText,
  SquareKanban,
  UserCog,
  ListOrdered,
  CalendarRange,
  Layers,
} from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ThemeToggle } from '@/components/ui/theme-toggle'

interface NavItem {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  roles?: string[]
}

const navItems: NavItem[] = [
  { label: 'Dashboard',     href: '/dashboard',     icon: LayoutDashboard },
  { label: 'Projects',      href: '/projects',      icon: FolderKanban },
  { label: 'Requests',      href: '/requests',      icon: ClipboardList },
  { label: 'Kanban',        href: '/kanban',        icon: SquareKanban },
  { label: 'Gantt',         href: '/gantt',         icon: GitBranch },
  { label: 'Timeline',      href: '/timeline',      icon: CalendarRange, roles: ['RESOURCE', 'PROJECT_LEAD', 'WORKSTREAM_LEAD', 'PLANNER', 'LEADERSHIP'] },
  { label: 'All Projects',  href: '/all-projects',  icon: Layers,        roles: ['ADMIN', 'MANAGER', 'PLANNER'] },
  { label: 'Queue',         href: '/queue',         icon: ListOrdered },
  { label: 'Resources',     href: '/resources',     icon: Users,         roles: ['ADMIN', 'MANAGER', 'PLANNER', 'PROJECT_LEAD', 'WORKSTREAM_LEAD', 'LEADERSHIP'] },
  { label: 'Approvals',     href: '/approvals',     icon: CheckSquare,   roles: ['ADMIN', 'MANAGER', 'PLANNER'] },
  { label: 'Reports',       href: '/reports',       icon: BarChart3 },
  { label: 'Documents',     href: '/documents',     icon: FileText },
  { label: 'Notifications', href: '/notifications', icon: Bell },
  { label: 'Settings',      href: '/settings',      icon: Settings },
  { label: 'Users',         href: '/users',         icon: UserCog,       roles: ['ADMIN'] },
]

interface SidebarNavProps {
  unreadCount?: number
  pendingRequestsCount?: number
  mobileOpen?: boolean
  onMobileClose?: () => void
}

export function SidebarNav({
  unreadCount = 0,
  pendingRequestsCount = 0,
  mobileOpen = false,
  onMobileClose,
}: SidebarNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { user, logout } = useAuthStore()
  const [collapsed, setCollapsed] = useState(false)

  const filteredNav = navItems.filter(
    (item) => !item.roles || (user && item.roles.includes(user.role))
  )

  async function handleLogout() {
    await logout()
    toast.success('Signed out successfully')
    router.push('/login')
  }

  const initials = user?.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside
        className={cn(
          'flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-300',
          /* Desktop: static, always visible, collapsible width */
          'lg:static lg:h-full lg:translate-x-0',
          collapsed ? 'lg:w-16' : 'lg:w-60',
          /* Mobile: fixed overlay */
          'fixed inset-y-0 left-0 z-50 h-full w-72 shadow-2xl',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        {/* Logo / header */}
        <div className="flex items-center h-14 px-3 border-b border-sidebar-border shrink-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-sidebar-primary">
            <BarChart3 className="h-4 w-4 text-white" />
          </div>
          {!collapsed && (
            <span className="ml-2.5 font-bold text-sidebar-foreground text-sm tracking-tight truncate">
              PMO Portal
            </span>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto p-1.5 rounded-md hover:bg-sidebar-accent text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors hidden lg:block"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
          {/* Mobile close */}
          <button
            onClick={onMobileClose}
            className="ml-auto p-1.5 rounded-md hover:bg-sidebar-accent text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors lg:hidden"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
          {filteredNav.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
            const Icon = item.icon
            const hasNotifBadge = item.label === 'Notifications' && unreadCount > 0
            const hasReqBadge = (item.label === 'Requests' || item.label === 'Approvals') && pendingRequestsCount > 0
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onMobileClose}
                className={cn(
                  'flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm transition-all duration-150',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-foreground font-medium shadow-sm'
                    : 'text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
                )}
              >
                <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-sidebar-primary' : 'text-sidebar-foreground/70')} />
                {!collapsed && (
                  <>
                    <span className="flex-1 truncate">
                      {item.href === '/projects' && user?.role === 'PROJECT_LEAD' ? 'My Projects' : item.label}
                    </span>
                    {hasNotifBadge && (
                      <Badge variant="destructive" className="text-xs px-1.5 py-0 h-5 min-w-[20px]">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </Badge>
                    )}
                    {hasReqBadge && (
                      <Badge className="text-xs px-1.5 py-0 h-5 min-w-[20px] bg-amber-500 hover:bg-amber-500 text-white">
                        {pendingRequestsCount > 9 ? '9+' : pendingRequestsCount}
                      </Badge>
                    )}
                  </>
                )}
                {collapsed && hasNotifBadge && (
                  <span className="absolute right-2 top-1 h-2 w-2 rounded-full bg-red-500" />
                )}
              </Link>
            )
          })}
        </nav>

        {/* Bottom: theme toggle + user */}
        <div className="shrink-0 border-t border-sidebar-border p-2 space-y-1">
          {/* Theme toggle row */}
          <div className={cn('flex items-center', collapsed ? 'justify-center' : 'px-1')}>
            <ThemeToggle />
            {!collapsed && (
              <span className="ml-1 text-xs text-sidebar-foreground/75 select-none">
                Toggle theme
              </span>
            )}
          </div>

          {/* User row */}
          {user && (
            <div className={cn('flex items-center gap-2 px-1', collapsed && 'justify-center')}>
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarFallback className="text-xs font-semibold bg-sidebar-primary text-white">
                  {initials}
                </AvatarFallback>
              </Avatar>
              {!collapsed && (
                <>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-sidebar-foreground truncate">{user.name}</p>
                    <p className="text-xs text-sidebar-foreground/70 truncate capitalize">
                      {user.role.toLowerCase().replace(/_/g, ' ')}
                    </p>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="p-1.5 rounded-md hover:bg-sidebar-accent text-sidebar-foreground/40 hover:text-red-400 transition-colors"
                    title="Sign out"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
