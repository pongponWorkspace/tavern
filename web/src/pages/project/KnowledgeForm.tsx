import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FileText, Link2, Lock, Paperclip, Plus, UploadCloud } from 'lucide-react';
import { api, ApiError, uploadFile, type Category, type ItemDetail, type ItemType, type Project, type ProjectRole } from '../../api';
import { bytes, PROJECT_ROLE_LABEL, TYPE_LABEL } from '../../lib/format';
import { ErrorAlert, Field, Menu, Modal, Spinner, useToast } from '../../components/ui';
import { TagInput } from '../../components/TagInput';
import { t } from '../../lib/i18n';

const RESTRICTABLE: Exclude<ProjectRole, 'project_admin'>[] = ['maintainer', 'member', 'viewer'];
type Caps = 'view' | 'edit' | 'archive';

/** Whether a role *can ever* have a capability under this project's permission table (item rules can only narrow). */
function baseCan(role: ProjectRole, cap: Caps, perms: Project['rolePermissions']): boolean {
  if (role === 'project_admin') return true;
  const r = perms[role];
  if (cap === 'view') return true;
  if (cap === 'edit') return r.edit !== 'none';
  return r.archive;
}

interface Props {
  project: Project;
  type?: ItemType | null; // create mode
  item?: ItemDetail | null; // edit mode
  onClose: () => void;
}

export function KnowledgeFormModal({ project, type, item, onClose }: Props) {
  const open = Boolean(type || item);
  return (
    <Modal open={open} onClose={onClose} wide title={item ? t('Edit {type}', { type: TYPE_LABEL[item.type] }) : type ? t('Add {type}', { type: TYPE_LABEL[type] }) : ''}>
      {open && <KnowledgeForm key={item?.id ?? type} project={project} type={(item?.type ?? type)!} item={item ?? null} onClose={onClose} />}
    </Modal>
  );
}

function KnowledgeForm({ project, type, item, onClose }: { project: Project; type: ItemType; item: ItemDetail | null; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const canRestrict = item ? item.permissions.restrict : project.permissions['knowledge.restrict'];
  const canPin = !item && (project.myRole === 'project_admin' || project.myRole === 'maintainer');

  const cats = useQuery({ queryKey: ['categories', project.id], queryFn: () => api<{ data: Category[] }>(`/projects/${project.id}/categories`) });
  const people = useQuery({ queryKey: ['people', project.id], queryFn: () => api(`/projects/${project.id}/people`) });
  const tagOptions = useQuery({ queryKey: ['tags', project.id, 'all'], queryFn: () => api<{ data: { name: string; itemCount: number }[] }>(`/projects/${project.id}/tags`, { query: { scope: 'all' } }) });

  const [title, setTitle] = useState(item?.title ?? '');
  const [url, setUrl] = useState(item?.externalUrl ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [categoryId, setCategoryId] = useState(item?.category?.id ?? '');
  const [tags, setTags] = useState<string[]>(item?.tags ?? []);
  const [ownerId, setOwnerId] = useState(item?.owner?.id ?? '');
  const [pinned, setPinned] = useState(false);
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Access: role → allowed caps. Starts from the item's current rules, or "everyone the policy allows".
  const initialAccess = () => {
    const a: Record<string, Record<Caps, boolean>> = {};
    for (const r of RESTRICTABLE) {
      a[r] = {
        view: item?.access ? item.access.visibilityRoles.includes(r) : true,
        edit: item?.access ? item.access.editRoles.includes(r) : baseCan(r, 'edit', project.rolePermissions),
        archive: item?.access ? item.access.archiveRoles.includes(r) : baseCan(r, 'archive', project.rolePermissions),
      };
    }
    return a;
  };
  const [access, setAccess] = useState(initialAccess);
  const [accessTouched, setAccessTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Duplicate-URL warning (FR-004 P1), debounced.
  const [dupes, setDupes] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (type !== 'external_link' || !/^https?:\/\/\S+\.\S+/.test(url)) return setDupes([]);
    const entry = setTimeout(() => {
      api(`/projects/${project.id}/knowledge/duplicates`, { query: { url, excludeId: item?.id } }).then((r) => setDupes(r.data)).catch(() => setDupes([]));
    }, 400);
    return () => clearTimeout(entry);
  }, [url, type, project.id, item?.id]);

  const toggle = (role: string, cap: Caps) => {
    setAccessTouched(true);
    setAccess((a) => {
      const next = { ...a, [role]: { ...a[role], [cap]: !a[role][cap] } };
      if (cap === 'view' && !next[role].view) next[role] = { view: false, edit: false, archive: false };
      if (cap !== 'view' && next[role][cap]) next[role].view = true;
      return next;
    });
  };

  const accessBody = () => {
    if (!canRestrict || !accessTouched) return {};
    const list = (cap: Caps) => ['project_admin', ...RESTRICTABLE.filter((r) => access[r][cap] && baseCan(r, cap, project.rolePermissions))];
    return { visibilityRoles: list('view'), editRoles: list('edit'), archiveRoles: list('archive') };
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const tagList = tags;
    try {
      if (item) {
        const updated = await api<ItemDetail>(`/knowledge/${item.id}`, {
          method: 'PATCH',
          body: {
            version: item.version, title, description, categoryId: categoryId || null, tags: tagList, ownerUserId: ownerId || null,
            ...(type === 'external_link' ? { externalUrl: url } : {}), ...accessBody(),
          },
        });
        qc.setQueryData(['item', item.id], updated);
        toast(t("Changes saved"));
      } else {
        let fileId: string | undefined;
        if (type === 'uploaded_file') {
          if (!file) throw new ApiError(422, 'VALIDATION_ERROR', 'Choose a file to upload.');
          setProgress(0);
          fileId = await uploadFile(project.id, file, setProgress);
        }
        const created = await api<ItemDetail & { warnings?: any }>(`/projects/${project.id}/knowledge`, {
          body: {
            type, title, description, categoryId: categoryId || null, tags: tagList, ownerUserId: ownerId || undefined,
            isPinned: canPin ? pinned : undefined,
            ...(type === 'external_link' ? { externalUrl: url } : {}),
            ...(type === 'uploaded_file' ? { fileId } : {}),
            ...(type === 'internal_document' ? { content } : {}),
            ...accessBody(),
          },
        });
        toast(type === 'uploaded_file' ? t('File added. It can be downloaded once the security scan finishes.') : t('{type} added', { type: TYPE_LABEL[type] }));
        navigate(`/p/${project.id}/k/${created.id}`);
      }
      await qc.invalidateQueries({ predicate: (q) => ['knowledge', 'overview', 'categories', 'tags', 'dashboard'].includes(q.queryKey[0] as string) });
      onClose();
    } catch (err) {
      setError(err);
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const pickFile = (f: File | undefined | null) => {
    if (!f) return;
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  };

  const valid = title.trim() && (type !== 'external_link' || url.trim()) && (type !== 'uploaded_file' || item || file);

  return (
    <form className="form" onSubmit={submit}>
      <ErrorAlert error={error} />

      {type === 'uploaded_file' && !item && (
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pickFile(e.dataTransfer.files[0]); }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
        >
          <input ref={fileInput} type="file" hidden onChange={(e) => pickFile(e.target.files?.[0])} accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.docx,.xlsx,.pptx" />
          <UploadCloud size={24} className="pin" />
          {file ? (
            <p style={{ marginTop: 6 }}><strong>{file.name}</strong> <span className="subtle">{bytes(file.size)}</span></p>
          ) : (
            <p style={{ marginTop: 6 }}><strong>{t("Drop a file here")}</strong>{' '}{t("or click to choose")}</p>
          )}
          <p className="subtle" style={{ marginTop: 4 }}>{t("PDF, images, Office, text or CSV · up to 25 MB")}</p>
          {progress !== null && <div className="progress" style={{ marginTop: 10 }}><span style={{ width: `${progress}%` }} /></div>}
        </div>
      )}

      <Field label={t("Title")} htmlFor="kt">
        <input id="kt" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus={type !== 'uploaded_file'} />
      </Field>

      {type === 'external_link' && (
        <Field label={t("URL")} htmlFor="ku">
          <input id="ku" className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" inputMode="url" />
        </Field>
      )}
      {dupes.length > 0 && (
        <div className="alert warn"><AlertTriangle size={16} /><span>{t("This link is already in the project as")}{' '}<strong>{dupes.map((d) => d.title).join(', ')}</strong>{t(". You can still add it.")}</span></div>
      )}

      <Field label={t("Description")} htmlFor="kd">
        <textarea id="kd" className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} style={{ minHeight: 70 }} />
      </Field>

      <div className="form-row">
        <Field label={t("Category")} htmlFor="kc">
          <select id="kc" className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{t("Uncategorized")}</option>
            {cats.data?.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label={t("Owner")} htmlFor="ko" hint={t("Who keeps it accurate")}>
          <select id="ko" className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {!item && <option value="">{t("Me")}</option>}
            {item && <option value="">{t("No owner")}</option>}
            {people.data?.data.map((p: any) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        </Field>
      </div>

      <Field label={t("Tags")} htmlFor="kg">
        <TagInput id="kg" value={tags} onChange={setTags} suggestions={tagOptions.data?.data ?? []} />
      </Field>

      {type === 'internal_document' && !item && (
        <Field label={t("Content")} htmlFor="kx" hint={t("Markdown")}>
          <textarea id="kx" className="textarea" value={content} onChange={(e) => setContent(e.target.value)} style={{ minHeight: 140, fontFamily: 'var(--font-mono)', fontSize: 13 }} />
        </Field>
      )}

      {canPin && (
        <label className="check"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />{' '}{t("Pin to the project overview")}</label>
      )}

      {canRestrict && (
        <details open={item?.access?.restricted} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}><Lock size={15} />{' '}{t("Who can access this item")}</summary>
          <p className="subtle" style={{ margin: '8px 0 12px' }}>{t("Roles without view access won't see this item anywhere.")}</p>
          <div className="role-grid" role="table" aria-label={t("Item access by role")}>
            <div className="hd" role="columnheader">{t("Role")}</div><div className="hd" role="columnheader">{t("View")}</div><div className="hd" role="columnheader">{t("Edit")}</div><div className="hd" role="columnheader">{t("Archive")}</div>
            <div role="cell"><strong>{t("Project Admin")}</strong></div>
            {(['view', 'edit', 'archive'] as Caps[]).map((c) => <div key={c} className="cell" role="cell"><input type="checkbox" checked disabled aria-label={t('Project Admin can {action}', { action: t(c) })} /></div>)}
            {RESTRICTABLE.map((r) => (
              <Fragment key={r}>
                <div role="cell">{PROJECT_ROLE_LABEL[r]}</div>
                {(['view', 'edit', 'archive'] as Caps[]).map((c) => {
                  const possible = baseCan(r, c, project.rolePermissions);
                  return (
                    <div key={`${r}-${c}`} className="cell" role="cell" title={possible ? '' : t("{role} can't {action} items in this project", { role: PROJECT_ROLE_LABEL[r], action: t(c) })}>
                      <input
                        type="checkbox"
                        checked={possible && access[r][c]}
                        disabled={!possible || (project.myRole === 'maintainer' && r === 'maintainer' && c !== 'archive')}
                        onChange={() => toggle(r, c)}
                        aria-label={t('{role} can {action}', { role: PROJECT_ROLE_LABEL[r], action: t(c) })}
                      />
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </details>
      )}

      <div className="row" style={{ marginTop: 4 }}>
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
        <button className="btn primary" disabled={busy || !valid}>
          {busy ? <><Spinner /> {progress !== null && progress < 100 ? t('Uploading {n}%', { n: progress }) : t("Saving")}</> : item ? t("Save changes") : t('Add {type}', { type: TYPE_LABEL[type] })}
        </button>
      </div>
    </form>
  );
}

/** The "Add" button and its Link / Document / File menu, shared by Overview and the Knowledge hub. */
export function AddKnowledgeMenu({ onPick, small }: { onPick: (type: ItemType) => void; small?: boolean }) {
  return (
    <Menu trigger={(tp) => <button className={`btn primary ${small ? 'sm' : ''}`} {...tp}><Plus size={small ? 15 : 16} />{' '}{t("Add")}</button>}>
      {(close) => (
        <>
          <button role="menuitem" onClick={() => { close(); onPick('external_link'); }}><Link2 size={15} />{' '}{t("Link")}<span className="subtle menu-hint">{t("Figma, GitHub, Jira…")}</span></button>
          <button role="menuitem" onClick={() => { close(); onPick('internal_document'); }}><FileText size={15} />{' '}{t("Document")}<span className="subtle menu-hint">{t("Write in Markdown")}</span></button>
          <button role="menuitem" onClick={() => { close(); onPick('uploaded_file'); }}><Paperclip size={15} />{' '}{t("File")}<span className="subtle menu-hint">{t("Up to 25 MB")}</span></button>
        </>
      )}
    </Menu>
  );
}
