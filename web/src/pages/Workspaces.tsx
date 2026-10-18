import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Building2, FolderKanban, Lock, MoreHorizontal, Plus } from 'lucide-react';
import { api } from '../api';
import { useMe, useTenantPerms } from '../lib/session';
import { timeAgo } from '../lib/format';
import { Empty, ErrorAlert, Field, Menu, Modal, RoleBadge, Spinner, errorText, useToast } from '../components/ui';
import { PageHeadSkeleton, TableSkeleton, TileGridSkeleton } from '../components/Skeletons';
import { NotFound } from './NotFound';

function useTenant(tenantId: string) {
  const me = useMe();
  const tenant = me.data?.tenants.find((t) => t.id === tenantId);
  return { tenant, perms: useTenantPerms(tenantId) };
}

function CreateWorkspace({ tenantId, open, onClose }: { tenantId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/tenants/${tenantId}/workspaces`, { body: { name, description } });
      await qc.invalidateQueries({ queryKey: ['workspaces', tenantId] });
      setName('');
      setDescription('');
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New workspace">
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="Name" htmlFor="wsn"><input id="wsn" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Product" /></Field>
        <Field label="Description" htmlFor="wsd" hint="Optional"><input id="wsd" className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || name.trim().length < 2}>{busy ? <Spinner /> : 'Create workspace'}</button></div>
      </form>
    </Modal>
  );
}

export function CreateProject({ workspaceId, open, onClose }: { workspaceId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', description: '', contact: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api(`/workspaces/${workspaceId}/projects`, { body: form });
      await qc.invalidateQueries();
      navigate(`/p/${p.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New project">
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="Project name" htmlFor="pn"><input id="pn" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
        <Field label="Description" htmlFor="pd" hint="Optional"><textarea id="pd" className="textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Contact" htmlFor="pc" hint="Optional"><input id="pc" className="input" value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} /></Field>
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || form.name.trim().length < 2}>{busy ? <Spinner /> : 'Create project'}</button></div>
      </form>
    </Modal>
  );
}

export function Workspaces() {
  const { tenantId = '' } = useParams();
  const { tenant, perms } = useTenant(tenantId);
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['workspaces', tenantId], queryFn: () => api(`/tenants/${tenantId}/workspaces`), enabled: Boolean(tenant) });
  if (!tenant) return <NotFound what="organization" />;
  if (q.isLoading) return <div className="content"><PageHeadSkeleton action={perms.createWorkspace} /><TileGridSkeleton n={3} /></div>;

  const setStatus = async (id: string, status: 'active' | 'archived') => {
    try {
      await api(`/workspaces/${id}`, { method: 'PATCH', body: { status } });
      await qc.invalidateQueries({ queryKey: ['workspaces', tenantId] });
      toast(status === 'archived' ? 'Workspace archived — its projects are now read-only' : 'Workspace restored');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <div className="content">
      <div className="page-head">
        <div><h1>Workspaces</h1></div>
        {perms.createWorkspace && <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> New workspace</button>}
      </div>
      <ErrorAlert error={q.error} />
      {q.data?.data.length === 0 ? (
        <div className="card"><Empty icon={<Building2 size={22} />} title="No workspaces yet" /></div>
      ) : (
        <div className="grid-3">
          {q.data?.data.map((w: any) => (
            <div key={w.id} className="card k-tile" style={{ opacity: w.status === 'archived' ? 0.7 : 1 }}>
              <div className="row">
                <span className="tenant-avatar"><Building2 size={14} /></span>
                <span className="spacer" />
                {w.status === 'archived' && <span className="badge">Archived</span>}
                {perms.editWorkspace && (
                  <Menu trigger={(p) => <button className="btn ghost icon sm" aria-label={`Actions for ${w.name}`} {...p}><MoreHorizontal size={16} /></button>}>
                    {(close) => w.status === 'active'
                      ? <button onClick={() => { close(); setStatus(w.id, 'archived'); }}><Archive size={15} /> Archive workspace</button>
                      : <button onClick={() => { close(); setStatus(w.id, 'active'); }}><ArchiveRestore size={15} /> Restore workspace</button>}
                  </Menu>
                )}
              </div>
              <Link to={`/t/${tenantId}/w/${w.id}`} className="k-title" style={{ fontSize: 16 }}>{w.name}</Link>
              {w.description && <p className="k-desc">{w.description}</p>}
              <div className="k-tile-foot"><FolderKanban size={14} /> {w.projectCount} {w.projectCount === 1 ? 'project' : 'projects'}{!perms.listAllProjects && ' you belong to'}</div>
            </div>
          ))}
        </div>
      )}
      <CreateWorkspace tenantId={tenantId} open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

export function WorkspaceDetail() {
  const { tenantId = '', workspaceId = '' } = useParams();
  const { tenant, perms } = useTenant(tenantId);
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['workspace-projects', workspaceId], queryFn: () => api(`/workspaces/${workspaceId}/projects`), enabled: Boolean(tenant) });
  if (!tenant) return <NotFound what="organization" />;
  if (q.isLoading) return <div className="content"><PageHeadSkeleton crumbs action={perms.createProject} /><TableSkeleton rows={4} cols={4} avatar={false} /></div>;
  if (q.error) return <NotFound what="workspace" />;
  const ws = q.data.workspace;
  const archived = ws.status === 'archived';
  return (
    <div className="content">
      <div className="page-head">
        <div>
          <div className="crumbs"><Link to={`/t/${tenantId}/workspaces`}>Workspaces</Link> /</div>
          <h1>{ws.name}</h1>
          {ws.description && <p className="lede">{ws.description}</p>}
        </div>
        {perms.createProject && !archived && <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> New project</button>}
      </div>
      {archived && <div style={{ marginBottom: 16 }}><div className="alert warn">This workspace is archived. Its projects are read-only until it is restored.</div></div>}
      <div className="card">
        {q.data.data.length === 0 ? (
          <Empty icon={<FolderKanban size={22} />} title="No projects here yet" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Project</th><th>Your access</th><th>Members</th><th>Updated</th></tr></thead>
              <tbody>
                {q.data.data.map((p: any) => (
                  <tr key={p.id}>
                    <td>
                      {p.myRole ? <Link to={`/p/${p.id}`} className="person-name">{p.name}</Link> : <span className="person-name">{p.name}</span>}
                      {p.status === 'archived' && <span className="badge" style={{ marginLeft: 8 }}>Archived</span>}
                      {p.description && <div className="subtle ellipsis" style={{ maxWidth: 420 }}>{p.description}</div>}
                    </td>
                    <td>{p.myRole ? <RoleBadge role={p.myRole} /> : <span className="badge" title="Organization admins manage projects but need to be added to one to see its content."><Lock size={12} /> Not a member</span>}</td>
                    <td className="muted">{p.memberCount ?? '—'}</td>
                    <td className="muted">{timeAgo(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <CreateProject workspaceId={workspaceId} open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
