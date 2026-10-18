import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, BookOpen, FileText, LayoutGrid, Link2, List, MoreHorizontal, Paperclip, Pencil, Pin, PinOff, Plus, Search, Settings, Trash2 } from 'lucide-react';
import { api, type Category, type ItemSummary, type ItemType } from '../../api';
import { KnowledgeRow, KnowledgeTile, RowSkeleton } from '../../components/Knowledge';
import { ConfirmDialog, Empty, ErrorAlert, Field, Menu, Modal, errorText, useToast } from '../../components/ui';
import { AddKnowledgeMenu, KnowledgeFormModal } from './KnowledgeForm';
import { useProject } from './ProjectLayout';

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
    const t = setTimeout(() => draft !== filters.q && setFilter('q', draft.trim()), 300);
    return () => clearTimeout(t);
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
      <Menu trigger={(tp) => <button className="btn ghost icon sm" aria-label={`Actions for ${i.title}`} {...tp}><MoreHorizontal size={16} /></button>}>
        {(close) => (
          <>
            {perms.edit && i.status === 'active' && <button role="menuitem" onClick={() => { close(); setEditing(i.id); }}><Pencil size={15} /> Edit details</button>}
            {perms.pin && i.status === 'active' && (
              <button role="menuitem" onClick={() => { close(); act(() => api(`/knowledge/${i.id}/pin`, { method: i.isPinned ? 'DELETE' : 'POST' }), i.isPinned ? 'Unpinned' : 'Pinned to overview'); }}>
                {i.isPinned ? <><PinOff size={15} /> Unpin</> : <><Pin size={15} /> Pin to overview</>}
              </button>
            )}
            {perms.archive && i.status === 'active' && <button role="menuitem" onClick={() => { close(); setConfirmArchive(i); }}><Archive size={15} /> Archive</button>}
            {perms.archive && i.status === 'archived' && <button role="menuitem" onClick={() => { close(); act(() => api(`/knowledge/${i.id}/restore`, { method: 'POST' }), 'Restored'); }}><ArchiveRestore size={15} /> Restore</button>}
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
      <aside className="filter-rail" aria-label="Filters">
        {railBtn('All knowledge', !filtered && filters.status === 'active', () => { setDraft(''); setParams({}, { replace: true }); })}
        {railBtn('Pinned', filters.pinned === 'true', () => setFilter('pinned', filters.pinned === 'true' ? '' : 'true'))}
        <div className="rail-section">
          <div className="rail-head">
            <span>Categories</span>
            {p.permissions['category.manage'] && (
              <button className="btn ghost icon sm" onClick={() => setManagingCats(true)} aria-label="Manage categories" title="Manage categories">
                <Settings size={15} />
              </button>
            )}
          </div>
          {cats.data?.data.map((c) => railBtn(c.name, filters.categoryId === c.id, () => setFilter('category', filters.categoryId === c.id ? '' : c.id), c.itemCount, c.id))}
          {cats.data && cats.data.uncategorizedCount > 0 && railBtn('Uncategorized', filters.categoryId === 'none', () => setFilter('category', filters.categoryId === 'none' ? '' : 'none'), cats.data.uncategorizedCount)}
          {cats.data?.data.length === 0 && <span className="subtle" style={{ padding: '4px 8px' }}>No categories yet</span>}
        </div>
        {tags.data && tags.data.data.length > 0 && (
          <div className="rail-section">
            <div className="rail-head"><span>Tags</span></div>
            <div className="row wrap" style={{ gap: 6, padding: '0 6px' }}>
              {tags.data.data.slice(0, 18).map((t) => (
                <button key={t.slug} className={`tag ${filters.tag === t.slug ? 'on' : ''}`} onClick={() => setFilter('tag', filters.tag === t.slug ? '' : t.slug)} aria-pressed={filters.tag === t.slug}>{t.name}</button>
              ))}
            </div>
          </div>
        )}
        {canSeeArchived && (
          <div className="rail-section">
            <div className="rail-head"><span>Status</span></div>
            {railBtn('Archived', filters.status === 'archived', () => setFilter('status', filters.status === 'archived' ? '' : 'archived'))}
          </div>
        )}
      </aside>

      <div style={{ minWidth: 0 }}>
        <div className="toolbar">
          <div className="search">
            <Search size={16} />
            <input className="input" type="search" placeholder="Search title, description or tag" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Search this project's knowledge" />
          </div>
          <select className="select" style={{ width: 'auto' }} value={filters.type} onChange={(e) => setFilter('type', e.target.value)} aria-label="Type">
            <option value="">All types</option>
            <option value="external_link">Links</option>
            <option value="uploaded_file">Files</option>
            <option value="internal_document">Documents</option>
          </select>
          <select className="select" style={{ width: 'auto' }} value={filters.sort} onChange={(e) => setFilter('sort', e.target.value === 'updated' ? '' : e.target.value)} aria-label="Sort">
            <option value="updated">Recently updated</option>
            <option value="created">Recently added</option>
            <option value="title">Title A–Z</option>
          </select>
          <div className="seg" role="group" aria-label="Layout">
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-pressed={view === 'list'} aria-label="List view"><List size={15} /></button>
            <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} aria-pressed={view === 'grid'} aria-label="Grid view"><LayoutGrid size={15} /></button>
          </div>
          {canCreate && filters.status === 'active' && (
            <AddKnowledgeMenu onPick={setCreating} />
          )}
        </div>

        <div className="row" style={{ marginBottom: 10, minHeight: 22 }}>
          <span className="subtle" aria-live="polite">
            {total !== undefined && `${total} ${filters.status === 'archived' ? 'archived ' : ''}${total === 1 ? 'item' : 'items'}${filtered ? ' match' : ''}`}
          </span>
          {filtered && <button className="btn ghost sm" onClick={() => { setDraft(''); setParams(filters.status === 'archived' ? { status: 'archived' } : {}, { replace: true }); }}>Clear filters</button>}
        </div>

        <ErrorAlert error={list.error} />
        {list.isLoading ? (
          <div className="card"><RowSkeleton n={6} /></div>
        ) : items.length === 0 ? (
          <div className="card">
            {filtered ? (
              <Empty icon={<Search size={22} />} title="Nothing matches those filters">Try a broader search, or clear the filters.</Empty>
            ) : filters.status === 'archived' ? (
              <Empty icon={<Archive size={22} />} title="No archived items">Archived items are hidden from everyone else and can be restored here.</Empty>
            ) : (
              <Empty icon={<BookOpen size={22} />} title="No knowledge yet" action={canCreate ? <button className="btn primary" onClick={() => setCreating('external_link')}><Plus size={15} /> Add the first link</button> : undefined}>
                {canCreate ? 'Add links, upload files or write documents your team needs.' : 'Nothing has been shared with your role in this project yet.'}
              </Empty>
            )}
          </div>
        ) : view === 'list' ? (
          <div className="card"><div className="k-list">{items.map((i) => <KnowledgeRow key={i.id} item={i} actions={rowActions(i)} onTag={(t) => setFilter('tag', t)} />)}</div></div>
        ) : (
          <div className="grid-3">{items.map((i) => <KnowledgeTile key={i.id} item={i} />)}</div>
        )}
        {list.hasNextPage && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
            <button className="btn" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>
          </div>
        )}
      </div>

      <KnowledgeFormModal project={p} type={creating} onClose={() => setCreating(null)} />
      <KnowledgeFormModal project={p} item={editItem.data ?? null} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={Boolean(confirmArchive)}
        title="Archive this item?"
        confirmLabel="Archive"
        onClose={() => setConfirmArchive(null)}
        onConfirm={() => { const i = confirmArchive!; setConfirmArchive(null); act(() => api(`/knowledge/${i.id}/archive`, { method: 'POST' }), 'Archived — you can restore it from the Archived filter'); }}
      >
        <strong>{confirmArchive?.title}</strong> will be hidden from the project. It isn't deleted — people who manage archived items can restore it.
      </ConfirmDialog>
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
    <Modal open={open} onClose={onClose} title="Categories">
      <div className="form">
        <ErrorAlert error={error} />
        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api(`/projects/${projectId}/categories`, { body: { name } }), 'Category added')) setName(''); }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New category name" aria-label="New category name" />
          <button className="btn primary" disabled={!name.trim()}>Add</button>
        </form>
        <div className="card">
          {categories.length === 0 && <p className="subtle card-pad">No categories yet.</p>}
          {categories.map((c) => (
            <div key={c.id} className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-muted)' }}>
              <input
                className="input"
                defaultValue={c.name}
                aria-label={`Rename ${c.name}`}
                onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && run(() => api(`/categories/${c.id}`, { method: 'PATCH', body: { name: e.target.value.trim() } }), 'Renamed')}
              />
              <span className="subtle" style={{ whiteSpace: 'nowrap' }}>{c.itemCount} items</span>
              <button className="btn ghost icon sm" aria-label={`Delete ${c.name}`} onClick={() => { setMoveTo('none'); setRemoving(c); }}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        {removing && (
          <div className="card card-pad form" style={{ background: 'var(--color-surface-subtle)' }}>
            <strong>Delete “{removing.name}”?</strong>
            <Field label="Move its items to" htmlFor="mv">
              <select id="mv" className="select" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                <option value="none">Uncategorized</option>
                {categories.filter((c) => c.id !== removing.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <div className="row">
              <span className="spacer" />
              <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
              <button className="btn danger solid" onClick={async () => { if (await run(() => api(`/categories/${removing.id}`, { method: 'DELETE', query: { reassignTo: moveTo } }), 'Category deleted')) setRemoving(null); }}>Delete category</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
