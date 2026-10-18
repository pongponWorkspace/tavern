import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useMe } from '../lib/session';
import { BrandMark, ErrorAlert, Field, Spinner } from '../components/ui';

const STEPS = ['Organization', 'Workspace', 'Project', 'Starter links'];

/** First-run wizard (§4.3 Tenant Setup): tenant → workspace → project → starter knowledge. */
export function Setup() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ids, setIds] = useState<{ tenant?: string; workspace?: string; project?: string }>({});
  const [org, setOrg] = useState('');
  const [ws, setWs] = useState('General');
  const [proj, setProj] = useState({ name: '', description: '' });
  const [links, setLinks] = useState([{ title: '', url: '' }, { title: '', url: '' }]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 0) run(async () => {
      const t = await api('/tenants', { body: { name: org } });
      setIds({ tenant: t.id });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setStep(1);
    });
    if (step === 1) run(async () => {
      const w = await api(`/tenants/${ids.tenant}/workspaces`, { body: { name: ws } });
      setIds((x) => ({ ...x, workspace: w.id }));
      setStep(2);
    });
    if (step === 2) run(async () => {
      const p = await api(`/workspaces/${ids.workspace}/projects`, { body: proj });
      setIds((x) => ({ ...x, project: p.id }));
      setStep(3);
    });
    if (step === 3) run(async () => {
      const cat = await api(`/projects/${ids.project}/categories`, { body: { name: 'Getting started' } });
      for (const l of links.filter((l) => l.title.trim() && l.url.trim())) {
        await api(`/projects/${ids.project}/knowledge`, { body: { type: 'external_link', title: l.title, externalUrl: l.url, categoryId: cat.id, isPinned: true } });
      }
      await qc.invalidateQueries();
      navigate(`/p/${ids.project}`, { replace: true });
    });
  };

  const valid = [org.trim().length >= 2, ws.trim().length >= 2, proj.name.trim().length >= 2, true][step];

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '32px 16px' }}>
      <div style={{ width: '100%', maxWidth: 560 }}>
        <div className="row" style={{ marginBottom: 28 }}>
          <BrandMark />
          <strong style={{ fontSize: 18, letterSpacing: '-0.015em' }}>Tavern</strong>
          <span className="spacer" />
          {me.data && me.data.tenants.length > 0 && step === 0 && <Link to="/" className="btn ghost sm">Cancel</Link>}
        </div>
        <ol className="row" style={{ listStyle: 'none', padding: 0, margin: '0 0 24px', gap: 6 }} aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <li key={s} style={{ flex: 1 }} aria-current={i === step ? 'step' : undefined}>
              <div className="progress" style={{ height: 4 }}><span style={{ width: i <= step ? '100%' : '0%' }} /></div>
              <div className="subtle" style={{ marginTop: 6, fontSize: 12, color: i === step ? 'var(--color-fg)' : undefined, fontWeight: i === step ? 600 : 400 }}>
                {i < step && <Check size={12} style={{ verticalAlign: -1 }} />} {s}
              </div>
            </li>
          ))}
        </ol>
        <form className="card card-pad form" onSubmit={submit}>
          {step === 0 && (
            <>
              <div><h1>Create your organization</h1><p className="muted" style={{ marginTop: 6 }}>Your organization is a private space for your team. Nothing in it is visible to other organizations.</p></div>
              <Field label="Organization name" htmlFor="org"><input id="org" className="input" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Acme Studio" autoFocus /></Field>
            </>
          )}
          {step === 1 && (
            <>
              <div><h1>Add a workspace</h1><p className="muted" style={{ marginTop: 6 }}>Workspaces group projects — by product, department or client.</p></div>
              <Field label="Workspace name" htmlFor="ws"><input id="ws" className="input" value={ws} onChange={(e) => setWs(e.target.value)} autoFocus /></Field>
            </>
          )}
          {step === 2 && (
            <>
              <div><h1>Create your first project</h1><p className="muted" style={{ marginTop: 6 }}>Each project gets its own knowledge hub, members and onboarding checklist. You'll be its Project Admin.</p></div>
              <Field label="Project name" htmlFor="pn"><input id="pn" className="input" value={proj.name} onChange={(e) => setProj({ ...proj, name: e.target.value })} placeholder="Atlas Mobile App" autoFocus /></Field>
              <Field label="Description" htmlFor="pd" hint="Optional — shown at the top of the project page."><textarea id="pd" className="textarea" value={proj.description} onChange={(e) => setProj({ ...proj, description: e.target.value })} /></Field>
            </>
          )}
          {step === 3 && (
            <>
              <div><h1>Add a few key links</h1><p className="muted" style={{ marginTop: 6 }}>The links people ask for most — design files, repository, task board. They'll be pinned on the project page. You can skip this.</p></div>
              {links.map((l, i) => (
                <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
                  <Field label={i === 0 ? 'Title' : ''} htmlFor={`lt${i}`}><input id={`lt${i}`} className="input" value={l.title} placeholder="Figma design file" onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} /></Field>
                  <div style={{ flex: 1.4 }}>
                    <Field label={i === 0 ? 'URL' : ''} htmlFor={`lu${i}`}><input id={`lu${i}`} className="input" value={l.url} placeholder="https://" onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} /></Field>
                  </div>
                  <button type="button" className="btn ghost icon" aria-label="Remove link" onClick={() => setLinks(links.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
                </div>
              ))}
              {links.length < 6 && <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setLinks([...links, { title: '', url: '' }])}><Plus size={15} /> Add another</button>}
            </>
          )}
          <ErrorAlert error={error} />
          <div className="row">
            <span className="spacer" />
            {step === 3 && <button type="button" className="btn ghost" onClick={() => navigate(`/p/${ids.project}`)} disabled={busy}>Skip for now</button>}
            <button className="btn primary" disabled={busy || !valid}>{busy ? <Spinner /> : step === 3 ? 'Finish setup' : 'Continue'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
