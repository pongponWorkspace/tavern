import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router';
import { useMe, lastTenant } from './lib/session';
import { AppSplash } from './components/Skeletons';
import { AppShell } from './components/AppShell';
import { ForgotPassword, Login, Register, ResetPassword, VerifyEmail } from './pages/auth';
import { AcceptInvite } from './pages/Invite';
import { Setup } from './pages/Setup';
import { Dashboard } from './pages/Dashboard';
import { Workspaces, WorkspaceDetail } from './pages/Workspaces';
import { Account } from './pages/Account';
import { DevMailbox } from './pages/DevMailbox';
import { NotFound } from './pages/NotFound';
import { ProjectLayout } from './pages/project/ProjectLayout';
import { ProjectOverview } from './pages/project/Overview';
import { KnowledgeHub } from './pages/project/Knowledge';
import { ItemDetailPage } from './pages/project/ItemDetail';
import { OnboardingPage } from './pages/project/Onboarding';
import { MembersPage } from './pages/project/Members';
import { ActivityPage } from './pages/project/Activity';
import { ProjectSettings } from './pages/project/Settings';
import { TenantSettings } from './pages/tenant/TenantSettings';
import { ProjectRolesPage } from './pages/project/Roles';

function RequireAuth() {
  const me = useMe();
  const loc = useLocation();
  if (me.isLoading) return <AppSplash />;
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Outlet />;
}

/** The organization role table lives in Settings; keep the short /roles link working. */
function RedirectToTenantRoles() {
  const { tenantId } = useParams();
  return <Navigate to={`/t/${tenantId}/settings/roles`} replace />;
}

function Home() {
  const me = useMe();
  if (!me.data) return null;
  if (me.data.tenants.length === 0) return <Navigate to="/setup" replace />;
  const last = lastTenant();
  const entry = me.data.tenants.find((x) => x.id === last) ?? me.data.tenants[0];
  return <Navigate to={`/t/${entry.id}`} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/invite/:token" element={<AcceptInvite />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Home />} />
        <Route path="/setup" element={<Setup />} />
        <Route element={<AppShell />}>
          <Route path="/t/:tenantId" element={<Dashboard />} />
          <Route path="/t/:tenantId/workspaces" element={<Workspaces />} />
          <Route path="/t/:tenantId/w/:workspaceId" element={<WorkspaceDetail />} />
          <Route path="/t/:tenantId/roles" element={<RedirectToTenantRoles />} />
          <Route path="/t/:tenantId/settings/:tab?" element={<TenantSettings />} />
          <Route path="/account" element={<Account />} />
          <Route path="/dev/mailbox" element={<DevMailbox />} />
          <Route path="/p/:projectId" element={<ProjectLayout />}>
            <Route index element={<ProjectOverview />} />
            <Route path="knowledge" element={<KnowledgeHub />} />
            <Route path="k/:itemId" element={<ItemDetailPage />} />
            <Route path="onboarding" element={<OnboardingPage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="roles" element={<ProjectRolesPage />} />
            <Route path="settings" element={<ProjectSettings />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
