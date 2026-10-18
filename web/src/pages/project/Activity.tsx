import { AuditLog } from '../../components/AuditLog';
import { useProject } from './ProjectLayout';

export function ActivityPage() {
  const p = useProject();
  return (
    <div>
      <div className="section-head"><div><h2>Activity</h2><p className="subtle">Who changed knowledge, membership, invitations and settings in this project. Visible to Project Admins only.</p></div></div>
      <AuditLog endpoint={`/projects/${p.id}/audit-logs`} />
    </div>
  );
}
