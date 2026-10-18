import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useIsFetching, useQuery } from '@tanstack/react-query';
import {
  Building2, Check, ChevronsUpDown, Home, Inbox, LogOut, Menu as MenuIcon, Moon, Plus, Settings, User,
} from 'lucide-react';
import { api, type Project } from '../api';
import { cycleTheme, lastTenant, rememberTenant, useMe, useSignOut, useTenantPerms } from '../lib/session';
import { colorFor, TENANT_ROLE_LABEL } from '../lib/format';
import { Avatar, BrandMark, Menu } from './ui';
import { AppSplash, NavSkeleton } from './Skeletons';
import { GlobalSearch } from './GlobalSearch';

/** Resolve the current organization from the URL (directly, or via the open project). */
function useCurrentTenantId(): string | null {
  const { pathname } = useLocation();
  const me = useMe();
  const t = /^\/t\/([^/]+)/.exec(pathname)?.[1];
  const p = /^\/p\/([^/]+)/.exec(pathname)?.[1];
  const project = useQuery({ queryKey: ['project', p], queryFn: () => api<Project>(`/projects/${p}`), enabled: Boolean(p) });
  if (t) return t;
  if (p && project.data) return project.data.tenant.id;
  // No organization in the URL yet (or the project is still loading): keep the
  // last one so the sidebar doesn't flicker empty.
  const tenants = me.data?.tenants ?? [];
  const last = lastTenant();
  return tenants.find((x) => x.id === last)?.id ?? tenants[0]?.id ?? null;
}

export function AppShell() {
  const me = useMe();
  const tenantId = useCurrentTenantId();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const [navOpen, setNavOpen] = useState(false);
  const refreshing = useDelayedFlag(useIsFetching() > 0, 250);

  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    if (tenantId) rememberTenant(tenantId);
  }, [tenantId]);

  const tenant = me.data?.tenants.find((t) => t.id === tenantId) ?? null;
  const perms = useTenantPerms(tenant?.id);
  const dashboard = useQuery({
    queryKey: ['dashboard', tenantId],
    queryFn: () => api(`/tenants/${tenantId}/dashboard`),
    enabled: Boolean(tenant),
  });

  if (!me.data) return <AppSplash />;
  const user = me.data.user;

  const projects: any[] = dashboard.data?.projects ?? [];

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <a href="#main" className="skip-link">Skip to content</a>
      <aside className="sidebar" aria-label="Main navigation">
        <Link to="/" className="brand">
          <BrandMark /> Tavern
        </Link>

        <Menu
          align="left"
          trigger={(p) => (
            <button className="tenant-switch" {...p}>
              <span className="tenant-avatar" style={tenant ? { background: colorFor(tenant.id) } : undefined}>{(tenant?.name ?? '?')[0]}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>{tenant?.name ?? 'Choose organization'}</span>
                {tenant && <span className="subtle" style={{ fontSize: 12 }}>{TENANT_ROLE_LABEL[tenant.role]}</span>}
              </span>
              <ChevronsUpDown size={16} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="menu-label">Organizations</div>
              {me.data!.tenants.map((t) => (
                <button key={t.id} role="menuitem" onClick={() => { close(); navigate(`/t/${t.id}`); }}>
                  <span className="tenant-avatar" style={{ width: 20, height: 20, fontSize: 9, background: colorFor(t.id) }}>{t.name[0]}</span>
                  <span className="ellipsis" style={{ flex: 1 }}>{t.name}</span>
                  {t.id === tenantId && <Check size={15} />}
                </button>
              ))}
              <div className="menu-sep" />
              <button role="menuitem" onClick={() => { close(); navigate('/setup'); }}>
                <Plus size={15} /> New organization
              </button>
            </>
          )}
        </Menu>

        {tenant && (
          <nav className="nav">
            <NavLink to={`/t/${tenant.id}`} end><Home size={16} /> Home</NavLink>
            <NavLink to={`/t/${tenant.id}/workspaces`}><Building2 size={16} /> Workspaces</NavLink>

            {dashboard.isLoading && <><div className="nav-label">Your projects</div><NavSkeleton /></>}
            {projects.length > 0 && <div className="nav-label">Your projects</div>}
            {projects.slice(0, 12).map((p) => (
              <NavLink key={p.id} to={`/p/${p.id}`} className={() => (pathname.startsWith(`/p/${p.id}`) ? 'active' : '')}>
                <span className="proj-sq" style={{ background: colorFor(p.id) }}>{p.name[0]}</span>
                <span className="ellipsis">{p.name}</span>
              </NavLink>
            ))}

          </nav>
        )}

        {tenant && (
          <nav className="nav nav-bottom" aria-label="Organization">
            <NavLink to={`/t/${tenant.id}/settings`} className={() => (pathname.startsWith(`/t/${tenant.id}/settings`) ? 'active' : '')}>
              <Settings size={16} /> Settings
            </NavLink>
          </nav>
        )}

        <div className="sidebar-foot">
          <Menu
            align="left"
            up
            trigger={(p) => (
              <button className="tenant-switch" style={{ border: 0, background: 'transparent' }} {...p} aria-label="Account menu">
                <Avatar id={user.id} name={user.displayName} url={user.avatarUrl} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>{user.displayName}</span>
                  <span className="ellipsis subtle" style={{ display: 'block', fontSize: 12 }}>{user.email}</span>
                </span>
              </button>
            )}
          >
            {(close) => (
              <>
                <button role="menuitem" onClick={() => { close(); navigate('/account'); }}><User size={15} /> Account settings</button>
                <button role="menuitem" onClick={() => { cycleTheme(); close(); }}><Moon size={15} /> Toggle theme</button>
                {import.meta.env.DEV && (
                  <button role="menuitem" onClick={() => { close(); navigate('/dev/mailbox'); }}><Inbox size={15} /> Dev mailbox</button>
                )}
                <div className="menu-sep" />
                <button role="menuitem" onClick={signOut}><LogOut size={15} /> Sign out</button>
              </>
            )}
          </Menu>
        </div>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} />

      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon menu-btn" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <MenuIcon size={16} />
          </button>
          {tenant && <GlobalSearch key={tenant.id} tenantId={tenant.id} tenantName={tenant.name} />}
          <span className="spacer" />
        </header>
        {refreshing && <div className="fetch-bar" role="progressbar" aria-label="Refreshing"><span /></div>}
        <main id="main" tabIndex={-1}>
          {!me.data.user.emailVerified && <VerifyBanner />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function VerifyBanner() {
  const [sent, setSent] = useState(false);
  return (
    <div style={{ padding: '12px 24px 0' }}>
      <div className="alert warn" role="status">
        <span>
          <strong>Verify your email address.</strong>{' '}
          {sent ? (
            'A new link is on its way.'
          ) : (
            <button className="btn ghost sm" style={{ height: 24 }} onClick={() => api('/auth/resend-verification', { method: 'POST' }).then(() => setSent(true))}>
              Resend link
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

/** True only once `on` has stayed true for `delay` ms — avoids flashing on fast requests. */
function useDelayedFlag(on: boolean, delay: number) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) return setShown(false);
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [on, delay]);
  return shown;
}
