import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Download, ScrollText } from 'lucide-react';
import { api } from '../api';
import { actionLabel, fullDate, timeAgo } from '../lib/format';
import { Avatar, Empty, ErrorAlert } from './ui';
import { TableSkeleton } from './Skeletons';

const GROUPS = [
  { value: '', label: 'All activity' },
  { value: 'knowledge.', label: 'Knowledge' },
  { value: 'project.member', label: 'Membership' },
  { value: 'invitation.', label: 'Invitations' },
  { value: 'file.', label: 'Files' },
  { value: 'project.', label: 'Project settings' },
  { value: 'tenant.', label: 'Organization' },
  { value: 'workspace.', label: 'Workspaces' },
  { value: 'onboarding.', label: 'Onboarding' },
];

/** Paginated, filterable audit trail (§4.3 Audit Log). */
export function AuditLog({ endpoint, groups = GROUPS }: { endpoint: string; groups?: typeof GROUPS }) {
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', endpoint, action, outcome, from],
    queryFn: ({ pageParam }) =>
      api(endpoint, { query: { action, outcome, from: from ? new Date(from).toISOString() : undefined, limit: 30, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: any) => last.page.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p: any) => p.data) ?? [];
  const exportQuery = new URLSearchParams(Object.entries({ action, outcome, from: from ? new Date(from).toISOString() : '' }).filter(([, v]) => v) as [string, string][]);
  const exportHref = `/api/v1${endpoint}/export${exportQuery.size ? `?${exportQuery}` : ''}`;
  return (
    <div>
      <div className="toolbar">
        <select className="select" style={{ width: 'auto' }} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Event type">
          {groups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
        <select className="select" style={{ width: 'auto' }} value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
          <option value="">Any outcome</option>
          <option value="success">Succeeded</option>
          <option value="denied">Denied</option>
          <option value="failure">Failed</option>
        </select>
        <label className="row subtle" style={{ gap: 6 }}>Since <input className="input" type="date" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <span className="spacer" />
        <a className="btn" href={exportHref} download><Download size={15} /> Export CSV</a>
      </div>
      <ErrorAlert error={q.error} />
      {q.isLoading ? <TableSkeleton rows={8} cols={4} /> : <div className="card table-wrap">
        {rows.length === 0 ? (
          <Empty icon={<ScrollText size={22} />} title="No matching activity" />
        ) : (
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Outcome</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }} title={fullDate(r.createdAt)}>{timeAgo(r.createdAt)}</td>
                  <td>{r.actor ? <span className="person"><Avatar id={r.actor.id} name={r.actor.displayName} size="sm" /> {r.actor.displayName}</span> : <span className="subtle">System</span>}</td>
                  <td>
                    {actionLabel(r.action)} {r.targetLabel && <strong>{r.targetLabel}</strong>}
                    {r.metadata?.fromRole && r.metadata?.toRole && <span className="subtle"> ({r.metadata.fromRole} → {r.metadata.toRole})</span>}
                    {r.metadata?.role && !r.metadata?.fromRole && <span className="subtle"> as {String(r.metadata.role).replace('_', ' ')}</span>}
                    {r.metadata?.reason && <span className="subtle"> — {String(r.metadata.reason).replace('_', ' ')}</span>}
                    <div className="subtle" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.action}</div>
                  </td>
                  <td><span className={`badge ${r.outcome === 'success' ? 'ok' : r.outcome === 'denied' ? 'danger' : 'outline'}`}>{r.outcome}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>}
      {q.hasNextPage && <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}><button className="btn" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? 'Loading…' : 'Load older'}</button></div>}
    </div>
  );
}
