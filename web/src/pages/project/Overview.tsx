import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, BookOpen, FileText, Link2, ListChecks, MessageSquare, Paperclip, Pin, Plus, ShieldAlert } from 'lucide-react';
import { api } from '../../api';
import { KnowledgeRow, KnowledgeTile, RowSkeleton } from '../../components/Knowledge';
import { Avatar, Empty, ErrorAlert } from '../../components/ui';
import { AddKnowledgeMenu, KnowledgeFormModal } from './KnowledgeForm';
import { useProject } from './ProjectLayout';
import { PROJECT_ROLE_LABEL, timeAgo } from '../../lib/format';
import { TileGridSkeleton } from '../../components/Skeletons';
import type { ItemType, ProjectRole } from '../../api';
import { t } from '../../lib/i18n';

export function ProjectOverview() {
  const p = useProject();
  const q = useQuery({ queryKey: ['overview', p.id], queryFn: () => api(`/projects/${p.id}/overview`) });
  const [creating, setCreating] = useState<ItemType | null>(null);
  const canCreate = p.permissions['knowledge.create'];
  const d = q.data;
  const ob = d?.onboarding;
  const obPct = ob && ob.required > 0 ? Math.round((ob.completed / ob.required) * 100) : null;

  return (
    <div>
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', alignItems: 'start' }}>
        <div className="stack" style={{ gap: 6 }}>
          {p.description ? <p style={{ fontSize: 16, color: 'var(--color-fg-muted)', maxWidth: 720 }}>{p.description}</p> : <p className="subtle">{t("No description yet.")}</p>}
          <div className="row wrap subtle" style={{ marginTop: 6, gap: 16 }}>
            {p.owner && <span className="row" style={{ gap: 6 }}><Avatar id={p.owner.id} name={p.owner.displayName} url={p.owner.avatarUrl} size="sm" />{' '}{t("Owner:")}{' '}{p.owner.displayName}</span>}
            {p.contact && <span className="row" style={{ gap: 6 }}><MessageSquare size={14} /> {p.contact}</span>}
          </div>
        </div>
        {obPct !== null && (
          <div className="card card-pad">
            <div className="row"><ListChecks size={18} className="pin" /><strong>{t("Your onboarding")}</strong></div>
            <div className="progress success" style={{ margin: '12px 0 8px' }}><span style={{ width: `${obPct}%` }} /></div>
            <span className="subtle">{obPct === 100 ? t("All done") : t('{done} of {total} done', { done: ob.completed, total: ob.required })}</span>
          </div>
        )}
      </div>

      <ErrorAlert error={q.error} />
      {p.permissions['members.manage'] && <Attention projectId={p.id} />}

      {d && d.counts.total === 0 ? (
        <div className="card section">
          <Empty
            icon={<BookOpen size={22} />}
            title={t("This project has no knowledge yet")}
            action={canCreate ? (
              <div className="row wrap" style={{ justifyContent: 'center' }}>
                <button className="btn primary" onClick={() => setCreating('external_link')}><Link2 size={15} />{' '}{t("Add a link")}</button>
                <button className="btn" onClick={() => setCreating('internal_document')}><FileText size={15} />{' '}{t("Write a doc")}</button>
                <button className="btn" onClick={() => setCreating('uploaded_file')}><Paperclip size={15} />{' '}{t("Upload a file")}</button>
              </div>
            ) : undefined}
          >
            {canCreate ? t("Start with the links people ask for most: the design file, repository and task board.") : t("Once your team adds links, files and documents, they will show up here.")}
          </Empty>
        </div>
      ) : (
        <>
          <section className="section">
            <div className="section-head">
              <h2><Pin size={16} className="pin" style={{ verticalAlign: -1 }} />{' '}{t("Pinned")}</h2>
              {canCreate && <AddKnowledgeMenu small onPick={setCreating} />}
            </div>
            {q.isLoading ? <TileGridSkeleton n={3} />
              : d.pinned.length === 0 ? <p className="subtle">{t("Nothing pinned yet")}{p.permissions['knowledge.restrict'] ? t(" — pin the essentials from the Knowledge tab.") : '.'}</p>
              : <div className="grid-3">{d.pinned.map((i: any) => <KnowledgeTile key={i.id} item={i} />)}</div>}
          </section>

          {d && d.categories.length > 0 && (
            <section className="section">
              <div className="section-head"><h2>{t("Browse by category")}</h2></div>
              <div className="row wrap" style={{ gap: 8 }}>
                {d.categories.map((c: any) => (
                  <Link key={c.id} to={`/p/${p.id}/knowledge?category=${c.id}`} className="btn">{c.name} <span className="subtle">{c.itemCount}</span></Link>
                ))}
              </div>
            </section>
          )}

          <section className="section">
            <div className="section-head">
              <h2>{t("Recent updates")}</h2>
            </div>
            <div className="card">{q.isLoading ? <RowSkeleton /> : <div className="k-list">{d.recent.map((i: any) => <KnowledgeRow key={i.id} item={i} />)}</div>}</div>
          </section>
        </>
      )}
      <KnowledgeFormModal project={p} type={creating} onClose={() => setCreating(null)} />
    </div>
  );
}

/** Only for Project Admins, and only rendered when there's something to act on. */
function Attention({ projectId }: { projectId: string }) {
  const q = useQuery({ queryKey: ['attention', projectId], queryFn: () => api(`/projects/${projectId}/attention`) });
  const invites = q.data?.expiringInvitations ?? [];
  const files = q.data?.blockedFiles ?? [];
  if (!invites.length && !files.length) return null;
  return (
    <section className="card attention" aria-labelledby="attention-title">
      <div className="card-head"><h3 id="attention-title"><AlertTriangle size={16} />{' '}{t("Needs attention")}</h3></div>
      <ul>
        {invites.map((i: any) => (
          <li key={i.id}>
            <Link2 size={15} />
            <span>{t("Invitation for")}{' '}<strong>{i.email ?? PROJECT_ROLE_LABEL[i.role as ProjectRole]}</strong>{' '}{t("expires")}{' '}{timeAgo(i.expiresAt)}</span>
            <Link to={`/p/${projectId}/members`} className="btn sm">{t("Review")}</Link>
          </li>
        ))}
        {files.map((f: any) => (
          <li key={f.id}>
            <ShieldAlert size={15} />
            <span><strong>{f.filename}</strong> {f.scanStatus === 'quarantined' ? t("was blocked by the security scan") : t("couldn’t be scanned")}</span>
            {f.item && <Link to={`/p/${projectId}/k/${f.item.id}`} className="btn sm">{t("Open")}</Link>}
          </li>
        ))}
      </ul>
    </section>
  );
}
