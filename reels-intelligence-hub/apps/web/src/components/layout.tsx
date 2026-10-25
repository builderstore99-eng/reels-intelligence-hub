import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bell,
  BookOpen,
  Bot,
  CalendarClock,
  Compass,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  MonitorPlay,
  Moon,
  Palette,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth, useTheme } from '../lib/app-context';
import { cn, relativeTime } from '../lib/utils';
import { Badge, Button, Spinner } from './ui';

/**
 * Application shell: persistent sidebar, top bar, and the page surface.
 *
 * Navigation is the single list below — every destination in the brief appears
 * once, and nothing in the sidebar is a placeholder.
 */

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/reels', label: 'Reels Search', icon: MonitorPlay },
  { to: '/designs', label: 'Design & Documents', icon: Palette },
  { to: '/topics', label: 'Topic Research', icon: Compass },
  { to: '/collections', label: 'My Collections', icon: BookOpen },
  { to: '/search', label: 'Global Search', icon: Search },
  { to: '/chat', label: 'AI Research Chat', icon: Bot },
  { to: '/monitor', label: 'Live Monitor', icon: Activity },
  { to: '/accounts', label: 'Connected Accounts', icon: Zap },
  { to: '/schedules', label: 'Scheduled Research', icon: CalendarClock },
  { to: '/usage', label: 'Usage & Costs', icon: Gauge },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useState('');
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { theme, resolved, setTheme } = useTheme();

  useEffect(() => {
    setMobileOpen(false);
    setUserMenuOpen(false);
    setNotificationsOpen(false);
  }, [location.pathname]);

  const monitor = useQuery({
    queryKey: ['monitor'],
    queryFn: () => api.jobs.monitor(),
    refetchInterval: 8000,
    retry: 1,
  });

  const pending = (monitor.data?.data.jobs ?? []).filter((job) =>
    ['queued', 'running', 'paused'].includes(job.status),
  );

  const notifications = useMemo(
    () =>
      pending.map((job) => ({
        id: job.id,
        title: `${job.jobType.replace('_', ' ')} · ${job.status}`,
        detail: `${job.completedItems}/${job.totalItems} items processed`,
        at: job.updatedAt,
      })),
    [pending],
  );

  function submitQuickSearch(event: React.FormEvent) {
    event.preventDefault();
    const term = quickSearch.trim();
    if (!term) return;
    navigate(`/search?q=${encodeURIComponent(term)}`);
    setQuickSearch('');
  }

  return (
    <div className="flex min-h-screen bg-[var(--color-ink-950)]">
      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-[var(--color-ink-700)] bg-[var(--color-ink-900)] transition-transform lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-[var(--color-ink-700)] px-4">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-[var(--radius-xs)] bg-[var(--color-accent-500)] text-[13px] font-bold text-white">
              R
            </span>
            <span className="text-[13px] font-semibold tracking-tight text-[var(--color-ink-100)]">
              Reels Intelligence
            </span>
          </Link>
          <button
            className="lg:hidden text-[var(--color-ink-400)]"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              className={({ isActive }) =>
                cn(
                  'mb-0.5 flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-[13px] transition-colors',
                  isActive
                    ? 'bg-[var(--color-ink-800)] font-medium text-[var(--color-ink-100)]'
                    : 'text-[var(--color-ink-300)] hover:bg-[var(--color-ink-850)] hover:text-[var(--color-ink-100)]',
                )
              }
            >
              <item.icon className="size-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-[var(--color-ink-700)] p-3">
          <div className="flex items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-ink-850)] px-2.5 py-2">
            {monitor.isFetching ? (
              <Spinner className="size-3.5" />
            ) : (
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  pending.length > 0 ? 'bg-[var(--color-info-500)]' : 'bg-[var(--color-ink-500)]',
                )}
              />
            )}
            <span className="text-[11px] text-[var(--color-ink-400)]">
              {pending.length > 0
                ? `${pending.length} job${pending.length === 1 ? '' : 's'} in flight`
                : 'Processing idle'}
            </span>
          </div>
        </div>
      </aside>

      {mobileOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      ) : null}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-[var(--color-ink-700)] bg-[var(--color-ink-950)]/85 px-4 backdrop-blur">
          <button
            className="lg:hidden text-[var(--color-ink-300)]"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="size-5" />
          </button>

          <form onSubmit={submitQuickSearch} className="relative min-w-0 flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-ink-500)]" />
            <input
              value={quickSearch}
              onChange={(event) => setQuickSearch(event.target.value)}
              placeholder="Search creators, topics, videos, and saved research…"
              aria-label="Global search"
              className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-ink-700)] bg-[var(--color-ink-850)] pl-8.5 pr-3 text-[13px] text-[var(--color-ink-100)] placeholder:text-[var(--color-ink-500)] focus:border-[var(--color-accent-500)] focus:outline-none"
            />
          </form>

          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="size-3.5" />}
              onClick={() => navigate('/reels')}
              className="hidden sm:inline-flex"
            >
              New Research
            </Button>

            <div className="relative">
              <button
                onClick={() => {
                  setNotificationsOpen((open) => !open);
                  setUserMenuOpen(false);
                }}
                className="relative rounded-[var(--radius-sm)] p-2 text-[var(--color-ink-300)] hover:bg-[var(--color-ink-850)] hover:text-[var(--color-ink-100)]"
                aria-label="Notifications"
              >
                <Bell className="size-4" />
                {pending.length > 0 ? (
                  <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-[var(--color-accent-500)]" />
                ) : null}
              </button>
              {notificationsOpen ? (
                <div className="fade-in absolute right-0 top-11 w-72 rounded-[var(--radius-md)] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-2 shadow-2xl">
                  <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-500)]">
                    Processing activity
                  </p>
                  {notifications.length === 0 ? (
                    <p className="px-2 py-3 text-[12px] text-[var(--color-ink-400)]">
                      Nothing running right now.
                    </p>
                  ) : (
                    notifications.map((notification) => (
                      <Link
                        key={notification.id}
                        to={`/monitor`}
                        className="block rounded-[var(--radius-xs)] px-2 py-2 hover:bg-[var(--color-ink-850)]"
                      >
                        <p className="text-[12px] capitalize text-[var(--color-ink-100)]">
                          {notification.title}
                        </p>
                        <p className="text-[11px] text-[var(--color-ink-400)]">
                          {notification.detail} · {relativeTime(notification.at)}
                        </p>
                      </Link>
                    ))
                  )}
                </div>
              ) : null}
            </div>

            <button
              onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
              className="rounded-[var(--radius-sm)] p-2 text-[var(--color-ink-300)] hover:bg-[var(--color-ink-850)] hover:text-[var(--color-ink-100)]"
              aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`}
              title={`Theme: ${theme}`}
            >
              {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>

            <div className="relative">
              <button
                onClick={() => {
                  setUserMenuOpen((open) => !open);
                  setNotificationsOpen(false);
                }}
                className="grid size-8 place-items-center rounded-full border border-[var(--color-ink-600)] bg-[var(--color-ink-800)] text-[12px] font-semibold text-[var(--color-ink-100)]"
                aria-label="Account menu"
              >
                {(user?.displayName ?? user?.email ?? '?').slice(0, 1).toUpperCase()}
              </button>
              {userMenuOpen ? (
                <div className="fade-in absolute right-0 top-11 w-56 rounded-[var(--radius-md)] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-1.5 shadow-2xl">
                  <div className="px-2 py-2">
                    <p className="truncate text-[13px] font-medium text-[var(--color-ink-100)]">
                      {user?.displayName}
                    </p>
                    <p className="truncate text-[11px] text-[var(--color-ink-400)]">
                      {user?.email}
                    </p>
                  </div>
                  <div className="my-1 h-px bg-[var(--color-ink-700)]" />
                  <Link
                    to="/settings"
                    className="flex items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 text-[13px] text-[var(--color-ink-200)] hover:bg-[var(--color-ink-850)]"
                  >
                    <SettingsIcon className="size-3.5" /> Settings
                  </Link>
                  <button
                    onClick={() => void logout()}
                    className="flex w-full items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 text-left text-[13px] text-[var(--color-ink-200)] hover:bg-[var(--color-ink-850)]"
                  >
                    <LogOut className="size-3.5" /> Sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1400px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
  badge,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--color-ink-100)]">
            {title}
          </h1>
          {badge}
        </div>
        {subtitle ? (
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--color-ink-400)]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[14px] font-semibold tracking-tight text-[var(--color-ink-100)]">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-[12px] text-[var(--color-ink-400)]">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function DemoBadge() {
  return <Badge tone="warning">DEMO DATA</Badge>;
}
