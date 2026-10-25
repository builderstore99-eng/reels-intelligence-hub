import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/app-context';
import { AppShell } from './components/layout';
import { Spinner } from './components/ui';

/**
 * Routing.
 *
 * Every page is lazy-loaded so the initial bundle stays small; the shell renders
 * immediately and the page fills in. Protected routes redirect to /login with a
 * `from` state so the user lands back where they were.
 */

const AuthPage = lazy(() => import('./pages/auth'));
const DashboardPage = lazy(() => import('./pages/dashboard'));
const ResearchPage = lazy(() => import('./pages/research'));
const CollectionsPage = lazy(() => import('./pages/collections'));
const CollectionDetailPage = lazy(() => import('./pages/collection-detail'));
const SearchPage = lazy(() => import('./pages/search'));
const ChatPage = lazy(() => import('./pages/chat'));
const MonitorPage = lazy(() => import('./pages/monitor'));
const AccountsPage = lazy(() => import('./pages/accounts'));
const SchedulesPage = lazy(() => import('./pages/schedules'));
const UsagePage = lazy(() => import('./pages/usage'));
const SettingsPage = lazy(() => import('./pages/settings'));

function Loading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Spinner className="size-5" />
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <Loading />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return <AppShell>{children}</AppShell>;
}

export function App() {
  const { status } = useAuth();

  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route
          path="/login"
          element={
            status === 'authenticated' ? <Navigate to="/" replace /> : <AuthPage mode="login" />
          }
        />
        <Route
          path="/register"
          element={
            status === 'authenticated' ? <Navigate to="/" replace /> : <AuthPage mode="register" />
          }
        />
        <Route
          path="/reset"
          element={
            status === 'authenticated' ? <Navigate to="/" replace /> : <AuthPage mode="reset" />
          }
        />

        <Route
          path="/"
          element={
            <Protected>
              <DashboardPage />
            </Protected>
          }
        />
        <Route
          path="/reels"
          element={
            <Protected>
              <ResearchPage kind="reels" />
            </Protected>
          }
        />
        <Route
          path="/designs"
          element={
            <Protected>
              <ResearchPage kind="designs" />
            </Protected>
          }
        />
        <Route
          path="/topics"
          element={
            <Protected>
              <ResearchPage kind="topics" />
            </Protected>
          }
        />
        <Route
          path="/collections"
          element={
            <Protected>
              <CollectionsPage />
            </Protected>
          }
        />
        <Route
          path="/collections/:id"
          element={
            <Protected>
              <CollectionDetailPage />
            </Protected>
          }
        />
        <Route
          path="/search"
          element={
            <Protected>
              <SearchPage />
            </Protected>
          }
        />
        <Route
          path="/chat"
          element={
            <Protected>
              <ChatPage />
            </Protected>
          }
        />
        <Route
          path="/monitor"
          element={
            <Protected>
              <MonitorPage />
            </Protected>
          }
        />
        <Route
          path="/accounts"
          element={
            <Protected>
              <AccountsPage />
            </Protected>
          }
        />
        <Route
          path="/schedules"
          element={
            <Protected>
              <SchedulesPage />
            </Protected>
          }
        />
        <Route
          path="/usage"
          element={
            <Protected>
              <UsagePage />
            </Protected>
          }
        />
        <Route
          path="/settings"
          element={
            <Protected>
              <SettingsPage />
            </Protected>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
