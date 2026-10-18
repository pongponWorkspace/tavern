import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Download, ScrollText } from 'lucide-react';
import { api } from '../api';
import { actionLabel, fullDate, timeAgo } from '../lib/format';
import { Avatar, Empty, ErrorAlert } from './ui';
import { TableSkeleton } from './Skeletons';
import { t } from '../lib/i18n';

const GROUPS = [
  { value: '', get label() { return t("All activity"); } },
  { value: 'knowledge.', get label() { return t("Knowledge"); } },
  { value: 'project.member', get label() { return t("Membership"); } },
  { value: 'invitation.', get label() { return t("Invitations"); } },
  { value: 'file.', get label() { return t("Files"); } },
  { value: 'project.', get label() { return t("Project settings"); } },
  { value: 'tenant.', get label() { return t("Organization"); } },
  { value: 'workspace.', get label() { return t("Workspaces"); } },
  { value: 'onboarding.', get label() { return t("Onboarding"); } },
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
        <select className="select" style={{ width: 'auto' }} value={action} onChange={(e) => setAction(e.target.value)} aria-label={t("Event type")}>
          {groups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
        <select className="select" style={{ width: 'auto' }} value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label={t("Outcome")}>
          <option value="">{t("Any outcome")}</option>
          <option value="success">{t("Succeeded")}</option>
          <option value="denied">{t("Denied")}</option>
          <option value="failure">{t("Failed")}</option>
        </select>
        <label className="row subtle" style={{ gap: 6 }}>{t("Since")}{' '}<input className="input" type="date" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <span className="spacer" />
        <a className="btn" href={exportHref} download><Download size={15} />{' '}{t("Export CSV")}</a>
      </div>
      <ErrorAlert error={q.error} />
      {q.isLoading ? <TableSkeleton rows={8} cols={4} /> : <div className="card table-wrap">
        {rows.length === 0 ? (
          <Empty icon={<ScrollText size={22} />} title={t("No matching activity")} />
        ) : (
          <table className="table">
            <thead><tr><th>{t("When")}</th><th>{t("Who")}</th><th>{t("What")}</th><th>{t("Outcome")}</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }} title={fullDate(r.createdAt)}>{timeAgo(r.createdAt)}</td>
                  <td>{r.actor ? <span className="person"><Avatar id={r.actor.id} name={r.actor.displayName} size="sm" /> {r.actor.displayName}</span> : <span className="subtle">{t("System")}</span>}</td>
                  <td>
                    {actionLabel(r.action)} {r.targetLabel && <strong>{r.targetLabel}</strong>}
                    {r.metadata?.fromRole && r.metadata?.toRole && <span className="subtle"> ({r.metadata.fromRole} → {r.metadata.toRole})</span>}
                    {r.metadata?.role && !r.metadata?.fromRole && <span className="subtle">{' '}{t("as")}{' '}{String(r.metadata.role).replace('_', ' ')}</span>}
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
      {q.hasNextPage && <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}><button className="btn" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? t("Loading…") : t("Load older")}</button></div>}
    </div>
  );
}
