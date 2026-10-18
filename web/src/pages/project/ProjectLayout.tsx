import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpen, Eye, LayoutDashboard, ListChecks, ScrollText, Settings, ShieldCheck, Users } from 'lucide-react';
import { api, setPreviewRole, type Project, type ProjectRole } from '../../api';
import { PROJECT_ROLE_LABEL } from '../../lib/format';
import { RoleBadge } from '../../components/ui';
import { ProjectSkeleton } from '../../components/Skeletons';
import { NotFound } from '../NotFound';
import { t } from '../../lib/i18n';

export const useProject = () => useOutletContext<{ project: Project }>().project;

export function useProjectQuery(projectId: string) {
  return useQuery({ queryKey: ['project', projectId], queryFn: () => api<Project>(`/projects/${projectId}`) });
}

/** Queries that depend on the project role. Session and organization data stay cached. */
const projectScoped = (q: { queryKey: readonly unknown[] }) => !['me', 'providers', 'tenant', 'dashboard', 'workspaces', 'storage'].includes(q.queryKey[0] as string);

export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [viewAs, setViewAs] = useState<Exclude<ProjectRole, 'project_admin'> | null>(null);
  const q = useProjectQuery(projectId);

  // Preview applies to this project only: switching project or leaving turns it off.
  const previewing = useRef(false);
  const changeViewAs = (role: typeof viewAs) => {
    setPreviewRole(role);
    previewing.current = Boolean(role);
    setViewAs(role);
    navigate(`/p/${projectId}`);
    qc.resetQueries({ predicate: projectScoped }); // project data was loaded as the previous role
  };
  useEffect(() => () => {
    if (!previewing.current) return;
    setPreviewRole(null);
    previewing.current = false;
    qc.resetQueries({ predicate: projectScoped });
  }, [projectId, qc]);
  useEffect(() => setViewAs(null), [projectId]);

  if (q.isLoading) return <ProjectSkeleton />;
  if (q.error || !q.data) return <NotFound what="project" />;
  const p = q.data;
  const admin = p.myRole === 'project_admin';
  const base = `/p/${p.id}`;
  return (
    <div className="content">
      {viewAs && (
        <div className="preview-bar" role="status">
          <Eye size={16} />{' '}{t("Viewing as")}{' '}<strong>{PROJECT_ROLE_LABEL[viewAs]}</strong>{t(". Changes are off.")}</div>
      )}
      <div className="page-head" style={{ marginBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div className="crumbs">
            <Link to={`/t/${p.tenant.id}/workspaces`}>{p.tenant.name}</Link> /
            <Link to={`/t/${p.tenant.id}/w/${p.workspace.id}`}>{p.workspace.name}</Link> /
          </div>
          <div className="row wrap" style={{ gap: 12 }}>
            <h1>{p.name}</h1>
            <RoleBadge role={p.myRole} />
            {p.status === 'archived' && <span className="badge warn"><Archive size={12} />{' '}{t("Archived")}</span>}
          </div>
        </div>
        {p.actualRole === 'project_admin' && (
          <label className="row view-as">
            <span className="subtle">{t("View as")}</span>
            <select className="select" aria-label={t("View project as")} value={viewAs ?? ''} onChange={(e) => changeViewAs((e.target.value || null) as typeof viewAs)}>
              <option value="">{t("Project Admin")}</option>
              <option value="maintainer">{t("Maintainer")}</option>
              <option value="member">{t("Member")}</option>
              <option value="viewer">{t("Viewer")}</option>
            </select>
          </label>
        )}
      </div>
      {!p.writable && (
        <div style={{ marginBottom: 16 }}>
          <div className="alert warn" role="status">
            {p.status === 'archived' ? t("This project is archived. Everything is read-only.") : t("This project’s workspace is archived. Everything is read-only.")}
            {admin && p.status === 'archived' && <>{' '}{t("You can restore it from")}{' '}<Link to={`${base}/settings`}>{t("Settings")}</Link>.</>}
          </div>
        </div>
      )}
      <nav className="tabs" aria-label={t("Project sections")}>
        <NavLink to={base} end><LayoutDashboard size={16} />{' '}{t("Overview")}</NavLink>
        <NavLink to={`${base}/knowledge`} className={({ isActive }) => (isActive || location.pathname.startsWith(`${base}/k/`) ? 'active' : '')}><BookOpen size={16} />{' '}{t("Knowledge")}</NavLink>
        <NavLink to={`${base}/onboarding`}><ListChecks size={16} />{' '}{t("Onboarding")}</NavLink>
        {admin && <NavLink to={`${base}/members`}><Users size={16} />{' '}{t("Members")}</NavLink>}
        {admin && <NavLink to={`${base}/activity`}><ScrollText size={16} />{' '}{t("Activity")}</NavLink>}
        <NavLink to={`${base}/roles`}><ShieldCheck size={16} />{' '}{t("Roles & permissions")}</NavLink>
        {(admin || p.permissions['onboarding.manage']) && <NavLink to={`${base}/settings`}><Settings size={16} />{' '}{t("Settings")}</NavLink>}
      </nav>
      <Outlet context={{ project: p }} />
    </div>
  );
}
