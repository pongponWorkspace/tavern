import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, BookOpen, FileText, LayoutGrid, Link2, List, Download, MoreHorizontal, Paperclip, Upload, Pencil, Pin, PinOff, Plus, Search, Settings, Trash2 } from 'lucide-react';
import { api, type Category, type ItemSummary, type ItemType } from '../../api';
import { KnowledgeRow, KnowledgeTile, RowSkeleton } from '../../components/Knowledge';
import { ConfirmDialog, Empty, ErrorAlert, Field, Menu, Modal, Spinner, errorText, useToast } from '../../components/ui';
import { AddKnowledgeMenu, KnowledgeFormModal } from './KnowledgeForm';
import { useProject } from './ProjectLayout';
import { t } from '../../lib/i18n';

export function KnowledgeHub() {
  const p = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState(params.get('q') ?? '');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [creating, setCreating] = useState<ItemType | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [managingCats, setManagingCats] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<ItemSummary | null>(null);

  const filters = {
    q: params.get('q') ?? '',
    type: params.get('type') ?? '',
    categoryId: params.get('category') ?? '',
    tag: params.get('tag') ?? '',
    pinned: params.get('pinned') ?? '',
    status: params.get('status') ?? 'active',
    sort: params.get('sort') ?? 'updated',
  };
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  // Debounce typing into the URL.
  useEffect(() => {
    const entry = setTimeout(() => draft !== filters.q && setFilter('q', draft.trim()), 300);
    return () => clearTimeout(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const list = useInfiniteQuery({
    queryKey: ['knowledge', p.id, filters],
    queryFn: ({ pageParam }) =>
      api<{ data: ItemSummary[]; page: { nextCursor: string | null; total: number } }>(`/projects/${p.id}/knowledge`, {
        query: { ...filters, categoryId: filters.categoryId, limit: 25, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const cats = useQuery({ queryKey: ['categories', p.id], queryFn: () => api<{ data: Category[]; uncategorizedCount: number }>(`/projects/${p.id}/categories`) });
  const tags = useQuery({ queryKey: ['tags', p.id], queryFn: () => api<{ data: { name: string; slug: string; itemCount: number }[] }>(`/projects/${p.id}/tags`) });
  const editItem = useQuery({ queryKey: ['item', editing], queryFn: () => api(`/knowledge/${editing}`), enabled: Boolean(editing) });

  const items = list.data?.pages.flatMap((pg) => pg.data) ?? [];
  const total = list.data?.pages[0]?.page.total;
  const canCreate = p.permissions['knowledge.create'];
  const canSeeArchived = p.permissions['knowledge.view_archived'];
  const filtered = Boolean(filters.q || filters.type || filters.categoryId || filters.tag || filters.pinned);

  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['knowledge', 'overview', 'categories', 'tags', 'dashboard', 'item'].includes(q.queryKey[0] as string) });
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      await refresh();
      toast(msg);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const rowActions = (i: ItemSummary) => {
    const perms = i.permissions;
    if (!perms || !(perms.edit || perms.pin || perms.archive)) return null;
    return (
      <Menu trigger={(tp) => <button className="btn ghost icon sm" aria-label={t('Actions for {name}', { name: i.title })} {...tp}><MoreHorizontal size={16} /></button>}>
        {(close) => (
          <>
            {perms.edit && i.status === 'active' && <button role="menuitem" onClick={() => { close(); setEditing(i.id); }}><Pencil size={15} />{' '}{t("Edit details")}</button>}
            {perms.pin && i.status === 'active' && (
              <button role="menuitem" onClick={() => { close(); act(() => api(`/knowledge/${i.id}/pin`, { method: i.isPinned ? 'DELETE' : 'POST' }), i.isPinned ? t("Unpinned") : t("Pinned to overview")); }}>
                {i.isPinned ? <><PinOff size={15} />{' '}{t("Unpin")}</> : <><Pin size={15} />{' '}{t("Pin to overview")}</>}
              </button>
            )}
            {perms.archive && i.status === 'active' && <button role="menuitem" onClick={() => { close(); setConfirmArchive(i); }}><Archive size={15} />{' '}{t("Archive")}</button>}
            {perms.archive && i.status === 'archived' && <button role="menuitem" onClick={() => { close(); act(() => api(`/knowledge/${i.id}/restore`, { method: 'POST' }), t("Restored")); }}><ArchiveRestore size={15} />{' '}{t("Restore")}</button>}
          </>
        )}
      </Menu>
    );
  };

  const railBtn = (label: string, on: boolean, onClick: () => void, count?: number, key?: string) => (
    <button key={key ?? label} className={on ? 'on' : ''} onClick={onClick} aria-pressed={on}>
      <span className="ellipsis">{label}</span>
      {count !== undefined && <span className="count">{count}</span>}
    </button>
  );

  return (
    <div className="layout-split">
      <aside className="filter-rail" aria-label={t("Filters")}>
        {railBtn(t("All knowledge"), !filtered && filters.status === 'active', () => { setDraft(''); setParams({}, { replace: true }); })}
        {railBtn(t("Pinned"), filters.pinned === 'true', () => setFilter('pinned', filters.pinned === 'true' ? '' : 'true'))}
        <div className="rail-section">
          <div className="rail-head">
            <span>{t("Categories")}</span>
            {p.permissions['category.manage'] && (
              <button className="btn ghost icon sm" onClick={() => setManagingCats(true)} aria-label={t("Manage categories")} title={t("Manage categories")}>
                <Settings size={15} />
              </button>
            )}
          </div>
          {cats.data?.data.map((c) => railBtn(c.name, filters.categoryId === c.id, () => setFilter('category', filters.categoryId === c.id ? '' : c.id), c.itemCount, c.id))}
          {cats.data && cats.data.uncategorizedCount > 0 && railBtn(t("Uncategorized"), filters.categoryId === 'none', () => setFilter('category', filters.categoryId === 'none' ? '' : 'none'), cats.data.uncategorizedCount)}
          {cats.data?.data.length === 0 && <span className="subtle" style={{ padding: '4px 8px' }}>{t("No categories yet")}</span>}
        </div>
        {tags.data && tags.data.data.length > 0 && (
          <div className="rail-section">
            <div className="rail-head"><span>{t("Tags")}</span></div>
            <div className="row wrap" style={{ gap: 6, padding: '0 6px' }}>
              {tags.data.data.slice(0, 18).map((entry) => (
                <button key={entry.slug} className={`tag ${filters.tag === entry.slug ? 'on' : ''}`} onClick={() => setFilter('tag', filters.tag === entry.slug ? '' : entry.slug)} aria-pressed={filters.tag === entry.slug}>{entry.name}</button>
              ))}
            </div>
          </div>
        )}
        {canSeeArchived && (
          <div className="rail-section">
            <div className="rail-head"><span>{t("Status")}</span></div>
            {railBtn(t("Archived"), filters.status === 'archived', () => setFilter('status', filters.status === 'archived' ? '' : 'archived'))}
          </div>
        )}
      </aside>

      <div style={{ minWidth: 0 }}>
        <div className="toolbar">
          <div className="search">
            <Search size={16} />
            <input className="input" type="search" placeholder={t("Search title, description or tag")} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t("Search this project's knowledge")} />
          </div>
          <select className="select" style={{ width: 'auto' }} value={filters.type} onChange={(e) => setFilter('type', e.target.value)} aria-label={t("Type")}>
            <option value="">{t("All types")}</option>
            <option value="external_link">{t("Links")}</option>
            <option value="uploaded_file">{t("Files")}</option>
            <option value="internal_document">{t("Documents")}</option>
          </select>
          <select className="select" style={{ width: 'auto' }} value={filters.sort} onChange={(e) => setFilter('sort', e.target.value === 'updated' ? '' : e.target.value)} aria-label={t("Sort")}>
            <option value="updated">{t("Recently updated")}</option>
            <option value="created">{t("Recently added")}</option>
            <option value="title">{t("Title A–Z")}</option>
          </select>
          <div className="seg" role="group" aria-label={t("Layout")}>
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-pressed={view === 'list'} aria-label={t("List view")}><List size={15} /></button>
            <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} aria-pressed={view === 'grid'} aria-label={t("Grid view")}><LayoutGrid size={15} /></button>
          </div>
          <Menu trigger={(tp) => <button className="btn icon" aria-label={t("More: import or export links")} {...tp}><MoreHorizontal size={16} /></button>}>
            {(close) => (
              <>
                {canCreate && p.writable && <button role="menuitem" onClick={() => { close(); setImporting(true); }}><Upload size={15} />{' '}{t("Import links")}</button>}
                <a role="menuitem" href={`/api/v1/projects/${p.id}/knowledge/export`} download onClick={close}><Download size={15} />{' '}{t("Export links")}</a>
              </>
            )}
          </Menu>
          {canCreate && filters.status === 'active' && (
            <AddKnowledgeMenu onPick={setCreating} />
          )}
        </div>

        <div className="row" style={{ marginBottom: 10, minHeight: 22 }}>
          <span className="subtle" aria-live="polite">
            {total !== undefined && `${total} ${filters.status === 'archived' ? 'archived ' : ''}${total === 1 ? 'item' : 'items'}${filtered ? ' match' : ''}`}
          </span>
          {filtered && <button className="btn ghost sm mobile-only" onClick={() => { setDraft(''); setParams(filters.status === 'archived' ? { status: 'archived' } : {}, { replace: true }); }}>{t("Clear filters")}</button>}
        </div>

        <ErrorAlert error={list.error} />
        {list.isLoading ? (
          <div className="card"><RowSkeleton n={6} /></div>
        ) : items.length === 0 ? (
          <div className="card">
            {filtered ? (
              <Empty icon={<Search size={22} />} title={t("Nothing matches")} />
            ) : filters.status === 'archived' ? (
              <Empty icon={<Archive size={22} />} title={t("No archived items")} />
            ) : (
              <Empty icon={<BookOpen size={22} />} title={t("No knowledge yet")} />
            )}
          </div>
        ) : view === 'list' ? (
          <div className="card"><div className="k-list">{items.map((i) => <KnowledgeRow key={i.id} item={i} actions={rowActions(i)} onTag={(entry) => setFilter('tag', entry)} />)}</div></div>
        ) : (
          <div className="grid-3">{items.map((i) => <KnowledgeTile key={i.id} item={i} />)}</div>
        )}
        {list.hasNextPage && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
            <button className="btn" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? t("Loading…") : t("Load more")}</button>
          </div>
        )}
      </div>

      <KnowledgeFormModal project={p} type={creating} onClose={() => setCreating(null)} />
      <KnowledgeFormModal project={p} item={editItem.data ?? null} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={Boolean(confirmArchive)}
        title={t("Archive this item?")}
        confirmLabel={t("Archive")}
        onClose={() => setConfirmArchive(null)}
        onConfirm={() => { const i = confirmArchive!; setConfirmArchive(null); act(() => api(`/knowledge/${i.id}/archive`, { method: 'POST' }), t("Archived — you can restore it from the Archived filter")); }}
      >
        <strong>{confirmArchive?.title}</strong>{' '}{t("will be hidden from the project. It isn't deleted — people who manage archived items can restore it.")}</ConfirmDialog>
      {importing && <ImportLinksModal projectId={p.id} onClose={() => setImporting(false)} onDone={refresh} />}
      <CategoryManager projectId={p.id} open={managingCats} onClose={() => setManagingCats(false)} categories={cats.data?.data ?? []} onChanged={refresh} />
    </div>
  );
}

function CategoryManager({ projectId, open, onClose, categories, onChanged }: { projectId: string; open: boolean; onClose: () => void; categories: Category[]; onChanged: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<Category | null>(null);
  const [moveTo, setMoveTo] = useState('none');
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    try {
      await fn();
      onChanged();
      toast(msg);
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Categories")}>
      <div className="form">
        <ErrorAlert error={error} />
        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api(`/projects/${projectId}/categories`, { body: { name } }), t("Category added"))) setName(''); }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("New category name")} aria-label={t("New category name")} />
          <button className="btn primary" disabled={!name.trim()}>{t("Add")}</button>
        </form>
        <div className="card">
          {categories.length === 0 && <p className="subtle card-pad">{t("No categories yet.")}</p>}
          {categories.map((c) => (
            <div key={c.id} className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-muted)' }}>
              <input
                className="input"
                defaultValue={c.name}
                aria-label={t('Rename {name}', { name: c.name })}
                onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && run(() => api(`/categories/${c.id}`, { method: 'PATCH', body: { name: e.target.value.trim() } }), t("Renamed"))}
              />
              <span className="subtle" style={{ whiteSpace: 'nowrap' }}>{c.itemCount}{' '}{t("items")}</span>
              <button className="btn ghost icon sm" aria-label={t('Delete {name}', { name: c.name })} onClick={() => { setMoveTo('none'); setRemoving(c); }}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        {removing && (
          <div className="card card-pad form" style={{ background: 'var(--color-surface-subtle)' }}>
            <strong>{t("Delete “")}{removing.name}”?</strong>
            <Field label={t("Move its items to")} htmlFor="mv">
              <select id="mv" className="select" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                <option value="none">{t("Uncategorized")}</option>
                {categories.filter((c) => c.id !== removing.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <div className="row">
              <span className="spacer" />
              <button className="btn" onClick={() => setRemoving(null)}>{t("Cancel")}</button>
              <button className="btn danger solid" onClick={async () => { if (await run(() => api(`/categories/${removing.id}`, { method: 'DELETE', query: { reassignTo: moveTo } }), t("Category deleted"))) setRemoving(null); }}>{t("Delete category")}</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Add many links from a CSV file (columns: title, url, description, category, tags). */
function ImportLinksModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ created: number; skipped: { row: number; title: string; reason: string }[] } | null>(null);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/projects/${projectId}/knowledge/import`, { body: { csv: await file.text() } });
      setResult(r);
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("Import links")}
      footer={result ? <button className="btn primary" onClick={onClose}>{t("Done")}</button> : (
        <>
          <button className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn primary" onClick={run} disabled={!file || busy}>{busy ? <Spinner /> : t("Import")}</button>
        </>
      )}
    >
      {result ? (
        <div className="stack">
          <p>{t('{n} added, {m} skipped.', { n: result.created, m: result.skipped.length })}</p>
          {result.skipped.length > 0 && (
            <div className="card table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
              <table className="table">
                <thead><tr><th>{t("Row")}</th><th>{t("Title")}</th><th>{t("Reason")}</th></tr></thead>
                <tbody>{result.skipped.map((s) => <tr key={s.row}><td>{s.row}</td><td>{s.title || '—'}</td><td className="muted">{s.reason}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="form">
          <ErrorAlert error={error} />
          <Field label={t("CSV file")} htmlFor="csv" hint={t("Columns: title, url, description, category, tags")}>
            <input id="csv" className="input" type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ paddingTop: 5 }} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
