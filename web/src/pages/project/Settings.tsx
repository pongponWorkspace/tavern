import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Copy } from 'lucide-react';
import { api } from '../../api';
import { ConfirmDialog, ErrorAlert, Field, Spinner, errorText, useToast } from '../../components/ui';
import { OnboardingStepsEditor } from './Onboarding';
import { useProject } from './ProjectLayout';
import { useTenantPerms } from '../../lib/session';

export function ProjectSettings() {
  const p = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const people = useQuery({ queryKey: ['people', p.id], queryFn: () => api(`/projects/${p.id}/people`) });
  const [form, setForm] = useState({ name: p.name, description: p.description, contact: p.contact, ownerUserId: p.owner?.id ?? '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const save = async (body: Record<string, unknown>, which: string) => {
    setBusy(which);
    setError(null);
    try {
      await api(`/projects/${p.id}`, { method: 'PATCH', body: { version: p.version, ...body } });
      await qc.invalidateQueries();
      toast('Settings saved');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const setStatus = async (to: 'archive' | 'restore') => {
    setBusy(to);
    try {
      await api(`/projects/${p.id}/${to}`, { method: 'POST' });
      await qc.invalidateQueries();
      toast(to === 'archive' ? 'Project archived' : 'Project restored');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(null);
      setConfirmArchive(false);
    }
  };
  const ro = !p.writable;
  const isAdmin = p.myRole === 'project_admin';
  const tenantPerms = useTenantPerms(p.tenant.id);
  const canOnboard = p.permissions['onboarding.manage'];
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  return (
    <div className="stack" style={{ gap: 24, maxWidth: 860 }}>
      <ErrorAlert error={error} />
      {isAdmin && <form className="card card-pad form" onSubmit={(e: FormEvent) => { e.preventDefault(); save({ ...form, ownerUserId: form.ownerUserId || null }, 'details'); }}>
        <h2>Project details</h2>
        <Field label="Name" htmlFor="sn"><input id="sn" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={ro} /></Field>
        <Field label="Description" htmlFor="sd"><textarea id="sd" className="textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={ro} /></Field>
        <div className="form-row">
          <Field label="Contact" htmlFor="sc"><input id="sc" className="input" value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} disabled={ro} /></Field>
          <Field label="Project owner" htmlFor="so">
            <select id="so" className="select" value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })} disabled={ro}>
              <option value="">No owner</option>
              {people.data?.data.map((u: any) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </select>
          </Field>
        </div>
        <div className="row"><span className="spacer" /><button className="btn primary" disabled={ro || busy !== null || form.name.trim().length < 2}>{busy === 'details' ? <Spinner /> : 'Save details'}</button></div>
      </form>}

      {canOnboard && (
        <section id="onboarding" className="card card-pad" style={{ scrollMarginTop: 72 }}>
          <OnboardingStepsEditor />
        </section>
      )}

      {isAdmin && tenantPerms.createProject && <DuplicateProject />}

      {isAdmin && <div className="card card-pad form" style={{ borderColor: 'var(--color-danger-muted)' }}>
        <h2>{p.status === 'archived' ? 'Restore project' : 'Archive project'}</h2>
        {p.status === 'archived' ? (
          <>
            <p className="muted">Makes the project editable again.</p>
            <div><button className="btn" onClick={() => setStatus('restore')} disabled={busy !== null}><ArchiveRestore size={15} /> Restore project</button></div>
          </>
        ) : (
          <>
            <p className="muted">Makes the project read-only. Nothing is deleted.</p>
            <div><button className="btn danger" onClick={() => setConfirmArchive(true)} disabled={busy !== null}><Archive size={15} /> Archive project</button></div>
          </>
        )}
      </div>}
      <ConfirmDialog open={confirmArchive} title={`Archive ${p.name}?`} confirmLabel="Archive project" danger busy={busy === 'archive'} onClose={() => setConfirmArchive(false)} onConfirm={() => setStatus('archive')}>
        Everything becomes read-only until a Project Admin restores it.
      </ConfirmDialog>
    </div>
  );
}

function DuplicateProject() {
  const p = useProject();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(`${p.name} (copy)`);
  const [includeContent, setIncludeContent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/projects/${p.id}/duplicate`, { body: { name, includeContent } });
      await qc.invalidateQueries();
      toast('Project duplicated');
      navigate(`/p/${r.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card card-pad form" onSubmit={submit}>
      <h2>Duplicate project</h2>
      <ErrorAlert error={error} />
      <Field label="New project name" htmlFor="dn"><input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <label className="check"><input type="checkbox" checked={includeContent} onChange={(e) => setIncludeContent(e.target.checked)} /> Copy links and documents</label>
      <p className="subtle">Members and uploaded files aren't copied.</p>
      <div className="row"><span className="spacer" /><button className="btn" disabled={busy || name.trim().length < 2}>{busy ? <Spinner /> : <><Copy size={15} /> Duplicate</>}</button></div>
    </form>
  );
}
