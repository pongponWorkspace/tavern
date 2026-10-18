import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Archive, BookOpen, LayoutDashboard, ListChecks, ScrollText, Settings, ShieldCheck, Users } from 'lucide-react';
import { api, type Project } from '../../api';
import { RoleBadge } from '../../components/ui';
import { ProjectSkeleton } from '../../components/Skeletons';
import { NotFound } from '../NotFound';

export const useProject = () => useOutletContext<{ project: Project }>().project;

export function useProjectQuery(projectId: string) {
  return useQuery({ queryKey: ['project', projectId], queryFn: () => api<Project>(`/projects/${projectId}`) });
}

export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const q = useProjectQuery(projectId);
  if (q.isLoading) return <ProjectSkeleton />;
  if (q.error || !q.data) return <NotFound what="project" />;
  const p = q.data;
  const admin = p.myRole === 'project_admin';
  const base = `/p/${p.id}`;
  return (
    <div className="content">
      <div className="page-head" style={{ marginBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div className="crumbs">
            <Link to={`/t/${p.tenant.id}/workspaces`}>{p.tenant.name}</Link> /
            <Link to={`/t/${p.tenant.id}/w/${p.workspace.id}`}>{p.workspace.name}</Link> /
          </div>
          <div className="row wrap" style={{ gap: 12 }}>
            <h1>{p.name}</h1>
            <RoleBadge role={p.myRole} />
            {p.status === 'archived' && <span className="badge warn"><Archive size={12} /> Archived</span>}
          </div>
        </div>
      </div>
      {!p.writable && (
        <div style={{ marginBottom: 16 }}>
          <div className="alert warn" role="status">
            {p.status === 'archived' ? 'This project is archived. Everything is read-only.' : 'This project’s workspace is archived. Everything is read-only.'}
            {admin && p.status === 'archived' && <> You can restore it from <Link to={`${base}/settings`}>Settings</Link>.</>}
          </div>
        </div>
      )}
      <nav className="tabs" aria-label="Project sections">
        <NavLink to={base} end><LayoutDashboard size={16} /> Overview</NavLink>
        <NavLink to={`${base}/knowledge`} className={({ isActive }) => (isActive || location.pathname.startsWith(`${base}/k/`) ? 'active' : '')}><BookOpen size={16} /> Knowledge</NavLink>
        <NavLink to={`${base}/onboarding`}><ListChecks size={16} /> Onboarding</NavLink>
        {admin && <NavLink to={`${base}/members`}><Users size={16} /> Members</NavLink>}
        {admin && <NavLink to={`${base}/activity`}><ScrollText size={16} /> Activity</NavLink>}
        <NavLink to={`${base}/roles`}><ShieldCheck size={16} /> Roles &amp; permissions</NavLink>
        {(admin || p.permissions['onboarding.manage']) && <NavLink to={`${base}/settings`}><Settings size={16} /> Settings</NavLink>}
      </nav>
      <Outlet context={{ project: p }} />
    </div>
  );
}
