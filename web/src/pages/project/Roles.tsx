import { ProjectRoleTable } from '../../components/RoleTables';
import { useProject } from './ProjectLayout';

/** Project access levels — visible to every member; Project Admins can edit. */
export function ProjectRolesPage() {
  const p = useProject();
  const editable = p.myRole === 'project_admin' && p.writable;
  return (
    <div style={{ maxWidth: 900 }}>
      {!editable && <p className="subtle" style={{ marginBottom: 14 }}>Only Project Admins can change this.</p>}
      <ProjectRoleTable projectId={p.id} value={p.rolePermissions} editable={editable} myRole={p.myRole} />
    </div>
  );
}
