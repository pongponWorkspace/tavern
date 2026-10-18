import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderKanban, Sparkles } from 'lucide-react';
import { api } from '../api';
import { useMe, useTenantPerms } from '../lib/session';
import { timeAgo } from '../lib/format';
import { KnowledgeRow, RowSkeleton } from '../components/Knowledge';
import { Empty, ErrorAlert, RoleBadge } from '../components/ui';
import { TileGridSkeleton } from '../components/Skeletons';
import { NotFound } from './NotFound';

export function Dashboard() {
  const { tenantId = '' } = useParams();
  const me = useMe();
  const tenant = me.data?.tenants.find((t) => t.id === tenantId);
  const perms = useTenantPerms(tenantId);
  const q = useQuery({ queryKey: ['dashboard', tenantId], queryFn: () => api(`/tenants/${tenantId}/dashboard`), enabled: Boolean(tenant) });
  if (!tenant) return <NotFound what="organization" />;
  const d = q.data;
  const isAdmin = perms.createProject;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>{greet}, {me.data!.user.displayName.split(' ')[0]}</h1>
          <p className="lede">Here's what's happening across your projects in {tenant.name}.</p>
        </div>
      </div>
      <ErrorAlert error={q.error} />

      <section>
        <div className="section-head">
          <h2>Your projects</h2>
          <Link to={`/t/${tenantId}/workspaces`} style={{ fontSize: 14 }}>All workspaces</Link>
        </div>
        {q.isLoading ? (
          <TileGridSkeleton n={3} />
        ) : d.projects.length === 0 ? (
          <div className="card">
            <Empty
              icon={<FolderKanban size={22} />}
              title="You're not on any projects yet"
              action={isAdmin ? <Link className="btn primary" to={`/t/${tenantId}/workspaces`}>Create a project</Link> : undefined}
            >
              {isAdmin
                ? 'Create a project, then invite your team with a link. Organization admins only see project content once they are added to the project.'
                : 'Ask a Project Admin to send you an invitation link to the project you work on.'}
            </Empty>
          </div>
        ) : (
          <div className="grid-3">
            {d.projects.map((p: any) => (
              <Link key={p.id} to={`/p/${p.id}`} className="card k-tile" style={{ color: 'inherit', textDecoration: 'none' }}>
                <div className="row">
                  <span className="subtle ellipsis">{p.workspace.name}</span>
                  <span className="spacer" />
                  <RoleBadge role={p.role} />
                </div>
                <div>
                  <div className="k-title" style={{ fontSize: 16 }}>{p.name}</div>
                  {p.description && <p className="k-desc">{p.description}</p>}
                </div>
                <div className="k-tile-foot">
                  <span>{p.itemCount} {p.itemCount === 1 ? 'resource' : 'resources'}</span>
                  {p.status === 'archived' && <span className="badge">Archived</span>}
                  <span className="spacer" />
                  <span>active {timeAgo(p.lastActivityAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head"><h2>Recently updated</h2></div>
        <div className="card">
          {q.isLoading ? <RowSkeleton /> : d.recentKnowledge.length === 0 ? (
            <Empty icon={<Sparkles size={22} />} title="Nothing here yet">Links, files and documents you can access will show up here as your team adds them.</Empty>
          ) : (
            <div className="k-list">{d.recentKnowledge.map((i: any) => <KnowledgeRow key={i.id} item={i} showProject />)}</div>
          )}
        </div>
      </section>
    </div>
  );
}
