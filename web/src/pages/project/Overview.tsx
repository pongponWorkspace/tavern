import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BookOpen, FileText, Link2, ListChecks, MessageSquare, Paperclip, Pin, Plus } from 'lucide-react';
import { api } from '../../api';
import { KnowledgeRow, KnowledgeTile, RowSkeleton } from '../../components/Knowledge';
import { Avatar, Empty, ErrorAlert } from '../../components/ui';
import { AddKnowledgeMenu, KnowledgeFormModal } from './KnowledgeForm';
import { useProject } from './ProjectLayout';
import { TileGridSkeleton } from '../../components/Skeletons';
import type { ItemType } from '../../api';

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
          {p.description ? <p style={{ fontSize: 16, color: 'var(--color-fg-muted)', maxWidth: 720 }}>{p.description}</p> : <p className="subtle">No description yet.</p>}
          <div className="row wrap subtle" style={{ marginTop: 6, gap: 16 }}>
            {p.owner && <span className="row" style={{ gap: 6 }}><Avatar id={p.owner.id} name={p.owner.displayName} url={p.owner.avatarUrl} size="sm" /> Owner: {p.owner.displayName}</span>}
            {p.contact && <span className="row" style={{ gap: 6 }}><MessageSquare size={14} /> {p.contact}</span>}
          </div>
        </div>
        {obPct !== null && (
          <Link to={`/p/${p.id}/onboarding`} className="card card-pad" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="row"><ListChecks size={18} className="pin" /><strong>Your onboarding</strong><span className="spacer" /><ArrowRight size={15} /></div>
            <div className="progress success" style={{ margin: '12px 0 8px' }}><span style={{ width: `${obPct}%` }} /></div>
            <span className="subtle">{obPct === 100 ? 'All required steps done' : `${ob.completed} of ${ob.required} required steps done`}</span>
          </Link>
        )}
      </div>

      <ErrorAlert error={q.error} />

      {d && d.counts.total === 0 ? (
        <div className="card section">
          <Empty
            icon={<BookOpen size={22} />}
            title="This project has no knowledge yet"
            action={canCreate ? (
              <div className="row wrap" style={{ justifyContent: 'center' }}>
                <button className="btn primary" onClick={() => setCreating('external_link')}><Link2 size={15} /> Add a link</button>
                <button className="btn" onClick={() => setCreating('internal_document')}><FileText size={15} /> Write a doc</button>
                <button className="btn" onClick={() => setCreating('uploaded_file')}><Paperclip size={15} /> Upload a file</button>
              </div>
            ) : undefined}
          >
            {canCreate ? 'Start with the links people ask for most: the design file, repository and task board.' : 'Once your team adds links, files and documents, they will show up here.'}
          </Empty>
        </div>
      ) : (
        <>
          <section className="section">
            <div className="section-head">
              <h2><Pin size={16} className="pin" style={{ verticalAlign: -1 }} /> Pinned</h2>
              {canCreate && <AddKnowledgeMenu small onPick={setCreating} />}
            </div>
            {q.isLoading ? <TileGridSkeleton n={3} />
              : d.pinned.length === 0 ? <p className="subtle">Nothing pinned yet{p.permissions['knowledge.restrict'] ? ' — pin the essentials from the Knowledge tab.' : '.'}</p>
              : <div className="grid-3">{d.pinned.map((i: any) => <KnowledgeTile key={i.id} item={i} />)}</div>}
          </section>

          {d && d.categories.length > 0 && (
            <section className="section">
              <div className="section-head"><h2>Browse by category</h2></div>
              <div className="row wrap" style={{ gap: 8 }}>
                {d.categories.map((c: any) => (
                  <Link key={c.id} to={`/p/${p.id}/knowledge?category=${c.id}`} className="btn">{c.name} <span className="subtle">{c.itemCount}</span></Link>
                ))}
              </div>
            </section>
          )}

          <section className="section">
            <div className="section-head">
              <h2>Recent updates</h2>
              <Link to={`/p/${p.id}/knowledge`} style={{ fontSize: 14 }}>All knowledge ({d?.counts.total ?? '…'})</Link>
            </div>
            <div className="card">{q.isLoading ? <RowSkeleton /> : <div className="k-list">{d.recent.map((i: any) => <KnowledgeRow key={i.id} item={i} />)}</div>}</div>
          </section>
        </>
      )}
      <KnowledgeFormModal project={p} type={creating} onClose={() => setCreating(null)} />
    </div>
  );
}
