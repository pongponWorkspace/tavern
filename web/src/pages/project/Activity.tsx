import { AuditLog } from '../../components/AuditLog';
import { useProject } from './ProjectLayout';

export function ActivityPage() {
  const p = useProject();
  return (
    <div>
      <AuditLog endpoint={`/projects/${p.id}/audit-logs`} />
    </div>
  );
}
