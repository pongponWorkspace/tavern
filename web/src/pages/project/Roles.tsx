import { ProjectRoleTable } from '../../components/RoleTables';
import { PROJECT_ROLE_LABEL } from '../../lib/format';
import { useProject } from './ProjectLayout';

/** Project access levels — visible to every member; Project Admins can edit. */
export function ProjectRolesPage() {
  const p = useProject();
  const editable = p.myRole === 'project_admin' && p.writable;
  return (
    <div style={{ maxWidth: 900 }}>
      <div className="section-head">
        <div>
          <h2>Roles &amp; permissions</h2>
          <p className="muted" style={{ marginTop: 4 }}>
            What each role can do in {p.name}. You are a <strong>{PROJECT_ROLE_LABEL[p.myRole]}</strong>.{' '}
            {editable ? 'Changes apply to everyone with that role on their next action.' : 'Only Project Admins can change this table.'}{' '}
            Individual items can still be restricted further.
          </p>
        </div>
      </div>
      <ProjectRoleTable projectId={p.id} value={p.rolePermissions} editable={editable} myRole={p.myRole} />
    </div>
  );
}
