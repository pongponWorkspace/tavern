import { Link } from 'react-router';
import { Pin, ShieldAlert, Clock } from 'lucide-react';
import type { ItemSummary } from '../api';
import { bytes, fullDate, hostOf, timeAgo, TYPE_LABEL } from '../lib/format';
import { Avatar, TypeIcon } from './ui';
import { t } from '../lib/i18n';

export function ScanBadge({ status }: { status: string }) {
  if (status === 'clean') return null;
  if (status === 'pending') return <span className="badge warn"><Clock size={12} />{' '}{t("Scanning")}</span>;
  return <span className="badge danger"><ShieldAlert size={12} /> {status === 'quarantined' ? t("Blocked") : t("Unavailable")}</span>;
}

function source(item: ItemSummary) {
  if (item.type === 'external_link') return hostOf(item.externalUrl);
  if (item.type === 'uploaded_file' && item.file) return `${item.file.name} · ${bytes(item.file.size)}`;
  return TYPE_LABEL[item.type];
}

/** Dense list row — title, why it matters, and who/when (§13.2). */
export function KnowledgeRow({ item, showProject, actions, onTag }: { item: ItemSummary; showProject?: boolean; actions?: React.ReactNode; onTag?: (entry: string) => void }) {
  return (
    <div className="k-row">
      <TypeIcon type={item.type} />
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <Link to={`/p/${item.projectId}/k/${item.id}`} className="k-title">{item.title}</Link>
          {item.isPinned && <Pin size={14} className="pin" aria-label={t("Pinned")} />}
          {item.status === 'archived' && <span className="badge">{t("Archived")}</span>}
          {item.file && <ScanBadge status={item.file.scanStatus} />}
        </div>
        {item.description && <p className="k-desc">{item.description}</p>}
        <div className="k-meta">
          <span>{source(item)}</span>
          {showProject && item.project && <><span className="sep" /><span>{item.project.name}</span></>}
          {item.category && <><span className="sep" /><span>{item.category.name}</span></>}
          {item.tags.slice(0, 4).map((entry) =>
            onTag ? <button key={entry} className="tag" onClick={() => onTag(entry)}>{entry}</button> : <span key={entry} className="tag">{entry}</span>,
          )}
          <span className="sep" />
          {item.owner && (
            <span className="row" style={{ gap: 6 }}>
              <Avatar id={item.owner.id} name={item.owner.displayName} url={item.owner.avatarUrl} size="sm" />
              {item.owner.displayName}
            </span>
          )}
          <span title={fullDate(item.updatedAt)}>{t("updated")}{' '}{timeAgo(item.updatedAt)}</span>
        </div>
      </div>
      {actions && <div className="k-actions">{actions}</div>}
    </div>
  );
}

/** Compact card for pinned resources. */
export function KnowledgeTile({ item }: { item: ItemSummary }) {
  return (
    <Link to={`/p/${item.projectId}/k/${item.id}`} className="card k-tile" style={{ color: 'inherit', textDecoration: 'none' }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <TypeIcon type={item.type} />
        <span className="spacer" />
        {item.file && <ScanBadge status={item.file.scanStatus} />}
        {item.isPinned && <Pin size={14} className="pin" aria-label={t("Pinned")} />}
      </div>
      <div>
        <div className="k-title">{item.title}</div>
        {item.description && <p className="k-desc">{item.description}</p>}
      </div>
      <div className="k-tile-foot">
        <span className="ellipsis">{source(item)}</span>
        <span className="spacer" />
        <span style={{ whiteSpace: 'nowrap' }}>{timeAgo(item.updatedAt)}</span>
      </div>
    </Link>
  );
}

export function RowSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div className="k-list" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="k-row">
          <div className="skeleton" style={{ width: 34, height: 34, borderRadius: 9 }} />
          <div className="stack" style={{ gap: 8 }}>
            <div className="skeleton" style={{ width: '40%', height: 14 }} />
            <div className="skeleton" style={{ width: '75%', height: 12 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
