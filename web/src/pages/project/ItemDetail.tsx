import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowLeft, Download, Eye, History, Lock, Pencil, Pin, PinOff, ShieldAlert, Trash2 } from 'lucide-react';
import { api, ApiError, type ItemDetail } from '../../api';
import { bytes, fullDate, PROJECT_ROLE_LABEL, timeAgo, TYPE_LABEL } from '../../lib/format';
import { Markdown } from '../../components/Markdown';
import { ScanBadge } from '../../components/Knowledge';
import { Alert, Avatar, ConfirmDialog, ErrorAlert, Modal, OpenLink, Spinner, TypeIcon, errorText, useToast } from '../../components/ui';
import { DetailSkeleton, DocSkeleton } from '../../components/Skeletons';
import { NotFound } from '../NotFound';
import { KnowledgeFormModal } from './KnowledgeForm';
import { useProject } from './ProjectLayout';

export function ItemDetailPage() {
  const p = useProject();
  const { itemId = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['item', itemId],
    queryFn: () => api<ItemDetail>(`/knowledge/${itemId}`),
    // Poll while a fresh upload is being scanned.
    refetchInterval: (query) => (query.state.data?.file?.scanStatus === 'pending' ? 2000 : false),
  });
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  if (q.isLoading) return <DetailSkeleton />;
  if (q.error || !q.data) return <NotFound what="item" />;
  const item = q.data;

  const refresh = () => qc.invalidateQueries({ predicate: (x) => ['knowledge', 'overview', 'categories', 'tags', 'dashboard', 'item'].includes(x.queryKey[0] as string) });
  const act = async (fn: () => Promise<unknown>, msg: string, after?: () => void) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      toast(msg);
      after?.();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const openFile = async (disposition: 'attachment' | 'inline') => {
    try {
      const r = await api<{ url: string }>(`/files/${item.file!.id}/download-url`, { query: { disposition } });
      if (disposition === 'inline') window.open(r.url, '_blank', 'noopener');
      else window.location.assign(r.url);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const previewable = item.file && item.file.scanStatus === 'clean' && /^(image\/|application\/pdf)/.test(item.file.mimeType ?? '');

  return (
    <div>

      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) 300px', alignItems: 'start', gap: 28 }}>
        <article style={{ minWidth: 0 }}>
          <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
            <TypeIcon type={item.type} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <h1 style={{ fontSize: 26, overflowWrap: 'anywhere' }}>{item.title}</h1>
              <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
                <span className="badge">{TYPE_LABEL[item.type]}</span>
                {item.isPinned && <span className="badge accent"><Pin size={12} /> Pinned</span>}
                {item.status === 'archived' && <span className="badge warn"><Archive size={12} /> Archived {timeAgo(item.archivedAt)}</span>}
                {item.access?.restricted && <span className="badge warn"><Lock size={12} /> Restricted</span>}
                {item.file && <ScanBadge status={item.file.scanStatus} />}
              </div>
            </div>
          </div>

          {item.description && <p style={{ marginTop: 18, fontSize: 16, color: 'var(--color-fg-muted)', maxWidth: 720 }}>{item.description}</p>}

          <div className="row wrap" style={{ marginTop: 20, gap: 8 }}>
            {item.type === 'external_link' && item.externalUrl && <OpenLink href={item.externalUrl} />}
            {item.type === 'uploaded_file' && item.file && (
              <>
                <button className="btn primary" onClick={() => openFile('attachment')} disabled={item.file.scanStatus !== 'clean'}><Download size={15} /> Download</button>
                {previewable && <button className="btn" onClick={() => openFile('inline')}><Eye size={15} /> Preview</button>}
              </>
            )}
            {item.permissions.edit && item.status === 'active' && <button className="btn" onClick={() => setEditing(true)}><Pencil size={15} /> Edit details</button>}
            {item.permissions.pin && item.status === 'active' && (
              <button className="btn" disabled={busy} onClick={() => act(() => api(`/knowledge/${item.id}/pin`, { method: item.isPinned ? 'DELETE' : 'POST' }), item.isPinned ? 'Unpinned' : 'Pinned to overview')}>
                {item.isPinned ? <><PinOff size={15} /> Unpin</> : <><Pin size={15} /> Pin</>}
              </button>
            )}
            {item.permissions.archive && item.status === 'active' && <button className="btn" onClick={() => setConfirm('archive')}><Archive size={15} /> Archive</button>}
            {item.permissions.archive && item.status === 'archived' && <button className="btn" disabled={busy} onClick={() => act(() => api(`/knowledge/${item.id}/restore`, { method: 'POST' }), 'Restored')}><ArchiveRestore size={15} /> Restore</button>}
            {item.permissions.delete && item.status === 'archived' && <button className="btn danger" onClick={() => setConfirm('delete')}><Trash2 size={15} /> Delete permanently</button>}
          </div>

          {item.type === 'external_link' && (
            <p className="subtle" style={{ marginTop: 10, overflowWrap: 'anywhere' }}>{item.externalUrl}</p>
          )}
          {item.file?.scanStatus === 'pending' && <div style={{ marginTop: 16 }}><Alert tone="info">This file is being scanned. Download becomes available when the check passes.</Alert></div>}
          {(item.file?.scanStatus === 'quarantined' || item.file?.scanStatus === 'failed') && (
            <div style={{ marginTop: 16 }}><Alert tone="danger" title={item.file.scanStatus === 'quarantined' ? 'Blocked by the security scan' : 'This file could not be checked'}>It can't be downloaded. Upload a different copy, or archive this item.</Alert></div>
          )}

          {item.type === 'internal_document' && <DocumentBody item={item} />}
        </article>

        <aside className="card card-pad stack" style={{ gap: 16, fontSize: 14 }}>
          <Meta label="Owner">{item.owner ? <span className="row" style={{ gap: 8 }}><Avatar id={item.owner.id} name={item.owner.displayName} url={item.owner.avatarUrl} size="sm" />{item.owner.displayName}</span> : <span className="subtle">No owner</span>}</Meta>
          <Meta label="Category">{item.category ? <Link to={`/p/${p.id}/knowledge?category=${item.category.id}`}>{item.category.name}</Link> : <span className="subtle">Uncategorized</span>}</Meta>
          {item.tags.length > 0 && <Meta label="Tags"><div className="row wrap" style={{ gap: 6 }}>{item.tags.map((t) => <Link key={t} to={`/p/${p.id}/knowledge?tag=${encodeURIComponent(t.toLowerCase())}`} className="tag">{t}</Link>)}</div></Meta>}
          {item.file && <Meta label="File">{item.file.name}<div className="subtle">{bytes(item.file.size)}{item.file.mimeType ? ` · ${item.file.mimeType}` : ''}</div></Meta>}
          <Meta label="Last updated"><span title={fullDate(item.updatedAt)}>{timeAgo(item.updatedAt)}</span> by {item.updatedBy.displayName}</Meta>
          <Meta label="Added"><span title={fullDate(item.createdAt)}>{timeAgo(item.createdAt)}</span> by {item.createdBy.displayName}</Meta>
          {item.access && (
            <Meta label="Who can see this">
              <span>{item.access.visibilityRoles.map((r) => PROJECT_ROLE_LABEL[r]).join(', ')}</span>
              {item.access.restricted && <div className="subtle" style={{ marginTop: 4 }}><ShieldAlert size={12} style={{ verticalAlign: -1 }} /> Hidden from everyone else, including search.</div>}
            </Meta>
          )}
        </aside>
      </div>

      <KnowledgeFormModal project={p} item={editing ? item : null} onClose={() => setEditing(false)} />
      <ConfirmDialog open={confirm === 'archive'} title="Archive this item?" confirmLabel="Archive" busy={busy} onClose={() => setConfirm(null)}
        onConfirm={() => act(() => api(`/knowledge/${item.id}/archive`, { method: 'POST' }), 'Archived')}>
        It will disappear from lists and search. People who manage archived items can restore it later.
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'delete'} title="Delete permanently?" confirmLabel="Delete forever" danger busy={busy} onClose={() => setConfirm(null)}
        onConfirm={() => act(() => api(`/knowledge/${item.id}`, { method: 'DELETE' }), 'Deleted permanently', () => navigate(`/p/${p.id}/knowledge?status=archived`))}>
        <strong>{item.title}</strong>{item.file ? ' and its file' : ''} will be removed for everyone. This can't be undone.
      </ConfirmDialog>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="subtle" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

/** Rendered Markdown with an in-place editor guarded by optimistic concurrency. */
function DocumentBody({ item }: { item: ItemDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['doc', item.id], queryFn: () => api(`/knowledge/${item.id}/content`) });
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const dirty = draft !== null && draft !== q.data?.content;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (q.isLoading) return <div style={{ marginTop: 14 }} role="status" aria-label="Loading document"><DocSkeleton /></div>;
  if (q.error) return <div style={{ marginTop: 28 }}><ErrorAlert error={q.error} /></div>;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/knowledge/${item.id}/content`, { method: 'PUT', body: { content: draft, version: q.data.version } });
      await qc.invalidateQueries({ queryKey: ['doc', item.id] });
      await qc.invalidateQueries({ queryKey: ['item', item.id] });
      await qc.invalidateQueries({ queryKey: ['revisions', item.id] });
      setDraft(null);
      toast('Document saved');
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  if (draft !== null) {
    return (
      <div style={{ marginTop: 28 }}>
        {error instanceof ApiError && error.status === 409 ? (
          <div style={{ marginBottom: 12 }}><Alert tone="warn" title="Someone else saved this document">Copy your changes somewhere safe, then reload to see the latest version.</Alert></div>
        ) : <ErrorAlert error={error} />}
        <div className="editor">
          <textarea className="textarea" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Document content (Markdown)" autoFocus />
          <div className="preview card card-pad" style={{ overflow: 'auto', maxHeight: 560 }}><Markdown source={draft} /></div>
        </div>
        <div className="row sticky-bar">
          <span className="subtle">Markdown · {draft.length.toLocaleString()} characters</span>
          <span className="spacer" />
          <button className="btn" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving || !dirty}>{saving ? <Spinner /> : 'Save document'}</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 28 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="subtle">{q.data.updatedBy ? `Last edited by ${q.data.updatedBy.displayName} ${timeAgo(q.data.updatedAt)}` : ''}</span>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setHistoryOpen(true)}><History size={14} /> History</button>
        {item.permissions.edit && item.status === 'active' && <button className="btn sm" onClick={() => setDraft(q.data.content)}><Pencil size={14} /> Edit</button>}
      </div>
      <div className="card card-pad" style={{ padding: '24px 28px' }}>
        {q.data.content.trim() ? <Markdown source={q.data.content} /> : <p className="subtle">Empty document.</p>}
      </div>
      {historyOpen && <HistoryModal item={item} version={q.data.version} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}

/** Past versions of a document: pick one to read it, restore it if you can edit. */
function HistoryModal({ item, version, onClose }: { item: ItemDetail; version: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['revisions', item.id], queryFn: () => api(`/knowledge/${item.id}/revisions`) });
  const [selected, setSelected] = useState<string | null>(null);
  const current = list.data?.data[0]?.id;
  const shown = selected ?? current;
  const rev = useQuery({ queryKey: ['revision', shown], queryFn: () => api(`/knowledge/${item.id}/revisions/${shown}`), enabled: Boolean(shown) });
  const [busy, setBusy] = useState(false);
  const canRestore = item.permissions.edit && item.status === 'active' && shown && shown !== current;

  const restore = async () => {
    setBusy(true);
    try {
      await api(`/knowledge/${item.id}/revisions/${shown}/restore`, { body: { version } });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['doc', item.id] }),
        qc.invalidateQueries({ queryKey: ['item', item.id] }),
        qc.invalidateQueries({ queryKey: ['revisions', item.id] }),
      ]);
      toast('Version restored');
      onClose();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="History" wide
      footer={<><button className="btn" onClick={onClose}>Close</button>{canRestore && <button className="btn primary" onClick={restore} disabled={busy}>{busy ? <Spinner /> : 'Restore this version'}</button>}</>}>
      <div className="history">
        <ul className="history-list" aria-label="Versions">
          {list.isLoading && <li className="subtle" style={{ padding: 12 }}><Spinner /></li>}
          {list.data?.data.map((r: any) => (
            <li key={r.id}>
              <button className={r.id === shown ? 'on' : ''} onClick={() => setSelected(r.id)} aria-pressed={r.id === shown}>
                <span className="history-when" title={fullDate(r.createdAt)}>{timeAgo(r.createdAt)}</span>
                <span className="subtle">{r.author.displayName}</span>
                {r.current ? <span className="badge accent">Current</span> : r.restored ? <span className="badge">Restored</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="history-preview">
          {rev.isLoading ? <Spinner /> : rev.data ? (rev.data.content.trim() ? <Markdown source={rev.data.content} /> : <p className="subtle">Empty.</p>) : null}
        </div>
      </div>
    </Modal>
  );
}
