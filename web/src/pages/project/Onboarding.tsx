import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, ListChecks, Pencil, Plus, Settings, Trash2, X } from 'lucide-react';
import { api, type ProjectRole } from '../../api';
import { PROJECT_ROLE_LABEL } from '../../lib/format';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
import { Empty, ErrorAlert, Field, Modal, Spinner, TypeIcon, errorText, useToast } from '../../components/ui';
import { ChecklistSkeleton, PageHeadSkeleton } from '../../components/Skeletons';
import { useProject } from './ProjectLayout';

export function OnboardingPage() {
  const p = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['onboarding', p.id], queryFn: () => api(`/projects/${p.id}/onboarding`) });
  if (q.isLoading) return <div style={{ maxWidth: 820 }}><PageHeadSkeleton /><ChecklistSkeleton /></div>;
  if (q.error) return <ErrorAlert error={q.error} />;
  const configure = `/p/${p.id}/settings#onboarding`;

  const templates: any[] = q.data.templates;
  const steps = templates.flatMap((t) => t.steps);
  const required = steps.filter((s) => s.isRequired);
  const done = required.filter((s) => s.completed).length;
  const pct = required.length ? Math.round((done / required.length) * 100) : 0;

  const toggle = async (step: any) => {
    // Optimistic: flip locally, then reconcile with the server.
    qc.setQueryData(['onboarding', p.id], (old: any) => ({
      ...old,
      templates: old.templates.map((t: any) => ({ ...t, steps: t.steps.map((s: any) => (s.id === step.id ? { ...s, completed: !s.completed } : s)) })),
    }));
    try {
      await api(`/onboarding/steps/${step.id}/complete`, { body: { completed: !step.completed } });
      qc.invalidateQueries({ queryKey: ['overview', p.id] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e) {
      toast(errorText(e), 'error');
      qc.invalidateQueries({ queryKey: ['onboarding', p.id] });
    }
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="row wrap" style={{ marginBottom: 20, gap: 16 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2>Getting started</h2>
        </div>
      </div>

      {templates.length === 0 ? (
        <div className="card">
          <Empty icon={<ListChecks size={22} />} title="No onboarding steps yet" action={q.data.canManage ? <Link className="btn primary" to={configure}><Plus size={15} /> Add steps</Link> : undefined} />
        </div>
      ) : (
        <>
          {required.length > 0 && (
            <div className="card card-pad" style={{ marginBottom: 20 }}>
              <div className="row"><strong>{pct === 100 ? 'All done — welcome aboard!' : `${done} of ${required.length} required steps complete`}</strong><span className="spacer" /><span className="subtle">{pct}%</span></div>
              <div className="progress success" style={{ marginTop: 10 }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Onboarding progress"><span style={{ width: `${pct}%` }} /></div>
            </div>
          )}
          <div className="stack" style={{ gap: 20 }}>
            {templates.map((t) => (
              <section key={t.id} className="card">
                <div className="card-head">
                  <div>
                    <h3>{t.name}</h3>
                    {t.description && <p className="subtle" style={{ marginTop: 2 }}>{t.description}</p>}
                  </div>
                  {t.targetRole && <span className="badge">For {PROJECT_ROLE_LABEL[t.targetRole as ProjectRole]}s</span>}
                </div>
                <div className="checklist">
                  {t.steps.length === 0 && <p className="subtle card-pad">No steps yet.</p>}
                  {t.steps.map((s: any) => (
                    <div key={s.id} className={`check-item ${s.completed ? 'done' : ''}`}>
                      <button className={`check-toggle ${s.completed ? 'done' : ''}`} onClick={() => toggle(s)} aria-pressed={s.completed} aria-label={`${s.completed ? 'Mark not done' : 'Mark done'}: ${s.title}`}>
                        <Check size={14} strokeWidth={3} />
                      </button>
                      <div style={{ minWidth: 0 }}>
                        <div className="row wrap" style={{ gap: 8 }}>
                          <span className="check-title">{s.title}</span>
                          {!s.isRequired && <span className="badge">Optional</span>}
                          {!s.completed && s.overdue && <span className="badge danger">Overdue</span>}
                          {!s.completed && !s.overdue && s.dueAt && <span className="badge">Due {shortDate(s.dueAt)}</span>}
                        </div>
                        {s.instructions && <p className="muted" style={{ fontSize: 14, marginTop: 2 }}>{s.instructions}</p>}
                        {s.resource && (
                          <Link to={`/p/${p.id}/k/${s.resource.id}`} className="row" style={{ gap: 8, marginTop: 8, fontSize: 14, fontWeight: 500 }}>
                            <TypeIcon type={s.resource.type} size="sm" /> {s.resource.title}
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ───────────────────────── Editor for Admins / Maintainers ─────────────────────────

/**
 * Onboarding step configuration, shown in project Settings. Steps on the
 * "everyone" checklist apply to every member; optional extra checklists can
 * target a single role.
 */
export function OnboardingStepsEditor() {
  const p = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['onboarding-templates', p.id], queryFn: () => api(`/projects/${p.id}/onboarding/templates`) });
  const items = useQuery({ queryKey: ['knowledge-all', p.id], queryFn: () => api(`/projects/${p.id}/knowledge`, { query: { limit: 100, sort: 'title' } }) });
  const [templateModal, setTemplateModal] = useState<any | null>(null);
  const [stepModal, setStepModal] = useState<{ templateId: string; step?: any } | null>(null);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['onboarding-templates', p.id] }),
      qc.invalidateQueries({ queryKey: ['onboarding', p.id] }),
      qc.invalidateQueries({ queryKey: ['overview', p.id] }),
    ]);
  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      await refresh();
      if (msg) toast(msg);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  if (q.isLoading) return <ChecklistSkeleton steps={4} />;

  const move = (steps: any[], i: number, dir: -1 | 1) => {
    const a = steps[i];
    const b = steps[i + dir];
    if (!b) return;
    run(async () => {
      await api(`/onboarding/steps/${a.id}`, { method: 'PATCH', body: { sortOrder: b.sortOrder } });
      await api(`/onboarding/steps/${b.id}`, { method: 'PATCH', body: { sortOrder: a.sortOrder === b.sortOrder ? a.sortOrder + dir : a.sortOrder } });
    });
  };

  const everyone = q.data.data.find((t: any) => !t.targetRole && t.status === 'active');
  const createEveryone = () =>
    run(() => api(`/projects/${p.id}/onboarding/templates`, { body: { name: 'Getting started', description: 'Everyone on the project does these first.', targetRole: null } }), 'Checklist created');

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2>Onboarding steps</h2>
        </div>
        <button className="btn" onClick={() => setTemplateModal({})}><Plus size={15} /> Role-specific checklist</button>
      </div>
      {!everyone && (
        <div className="card" style={{ marginBottom: 20 }}>
          <Empty icon={<ListChecks size={20} />} title="No steps yet" action={<button className="btn primary" onClick={createEveryone}><Plus size={15} /> Create the checklist</button>}>
          </Empty>
        </div>
      )}
      <div className="stack" style={{ gap: 20 }}>
        {q.data.data.map((t: any) => (
          <section key={t.id} className="card" style={{ opacity: t.status === 'archived' ? 0.65 : 1 }}>
            <div className="card-head">
              <div>
                <h3>{t.name} {t.status === 'archived' && <span className="badge">Archived</span>}</h3>
                <p className="subtle">{t.targetRole ? `${PROJECT_ROLE_LABEL[t.targetRole as ProjectRole]}s only` : 'Everyone on the project'}</p>
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => setTemplateModal(t)}><Pencil size={14} /> Edit</button>
                <button className="btn sm" onClick={() => run(() => api(`/onboarding/templates/${t.id}`, { method: 'PATCH', body: { status: t.status === 'active' ? 'archived' : 'active' } }), t.status === 'active' ? 'Checklist archived' : 'Checklist restored')}>
                  {t.status === 'active' ? 'Archive' : 'Restore'}
                </button>
              </div>
            </div>
            <div className="checklist">
              {t.steps.map((s: any, i: number) => (
                <div key={s.id} className="row" style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border-muted)', alignItems: 'flex-start' }}>
                  <span className="subtle" style={{ width: 20, paddingTop: 2 }}>{i + 1}.</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 8 }}><strong>{s.title}</strong>{!s.isRequired && <span className="badge">Optional</span>}{s.dueDays && <span className="badge">{s.dueDays} {s.dueDays === 1 ? 'day' : 'days'}</span>}</div>
                    {s.instructions && <p className="subtle">{s.instructions}</p>}
                    {s.resource && <p className="subtle" style={{ marginTop: 4 }}>Links to: {s.resource.hidden ? 'an item you can’t see' : s.resource.title}</p>}
                  </div>
                  <button className="btn ghost icon sm" aria-label="Move up" disabled={i === 0} onClick={() => move(t.steps, i, -1)}><ArrowUp size={15} /></button>
                  <button className="btn ghost icon sm" aria-label="Move down" disabled={i === t.steps.length - 1} onClick={() => move(t.steps, i, 1)}><ArrowDown size={15} /></button>
                  <button className="btn ghost icon sm" aria-label={`Edit ${s.title}`} onClick={() => setStepModal({ templateId: t.id, step: s })}><Pencil size={15} /></button>
                  <button className="btn ghost icon sm" aria-label={`Delete ${s.title}`} onClick={() => run(() => api(`/onboarding/steps/${s.id}`, { method: 'DELETE' }), 'Step removed')}><Trash2 size={15} /></button>
                </div>
              ))}
              <div style={{ padding: '12px 20px' }}>
                <button className="btn ghost sm" onClick={() => setStepModal({ templateId: t.id })}><Plus size={15} /> Add step</button>
              </div>
            </div>
          </section>
        ))}
      </div>

      <TemplateModal template={templateModal} onClose={() => setTemplateModal(null)} onSaved={refresh} />
      <StepModal state={stepModal} items={items.data?.data ?? []} onClose={() => setStepModal(null)} onSaved={refresh} />
    </div>
  );
}

function TemplateModal({ template, onClose, onSaved }: { template: any | null; onClose: () => void; onSaved: () => void }) {
  const p = useProject();
  const [form, setForm] = useState({ name: '', description: '', targetRole: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loadedFor, setLoadedFor] = useState<any>(null);
  if (template && loadedFor !== template) {
    setLoadedFor(template);
    setForm({ name: template.name ?? '', description: template.description ?? '', targetRole: template.targetRole ?? '' });
    setError(null);
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { name: form.name, description: form.description, targetRole: form.targetRole || null };
      if (template?.id) await api(`/onboarding/templates/${template.id}`, { method: 'PATCH', body });
      else await api(`/projects/${p.id}/onboarding/templates`, { body });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={Boolean(template)} onClose={onClose} title={template?.id ? 'Edit checklist' : 'New checklist'}>
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="Name" htmlFor="tn"><input id="tn" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
        <Field label="Description" htmlFor="td" hint="Optional"><input id="td" className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Who it's for" htmlFor="tr">
          <select id="tr" className="select" value={form.targetRole} onChange={(e) => setForm({ ...form, targetRole: e.target.value })}>
            <option value="">Everyone on the project</option>
            {(['project_admin', 'maintainer', 'member', 'viewer'] as ProjectRole[]).map((r) => <option key={r} value={r}>{PROJECT_ROLE_LABEL[r]}s only</option>)}
          </select>
        </Field>
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !form.name.trim()}>{busy ? <Spinner /> : 'Save'}</button></div>
      </form>
    </Modal>
  );
}

function StepModal({ state, items, onClose, onSaved }: { state: { templateId: string; step?: any } | null; items: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ title: '', instructions: '', knowledgeItemId: '', isRequired: true, dueDays: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loadedFor, setLoadedFor] = useState<any>(null);
  if (state && loadedFor !== state) {
    setLoadedFor(state);
    const s = state.step;
    setForm({ title: s?.title ?? '', instructions: s?.instructions ?? '', knowledgeItemId: s?.resource?.id ?? '', isRequired: s?.isRequired ?? true, dueDays: s?.dueDays ? String(s.dueDays) : '' });
    setError(null);
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...form, knowledgeItemId: form.knowledgeItemId || null, dueDays: form.dueDays ? Number(form.dueDays) : null };
      if (state?.step) await api(`/onboarding/steps/${state.step.id}`, { method: 'PATCH', body });
      else await api(`/onboarding/templates/${state!.templateId}/steps`, { body });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={Boolean(state)} onClose={onClose} title={state?.step ? 'Edit step' : 'Add step'}>
      <form className="form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="Step" htmlFor="st"><input id="st" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Read the welcome page" autoFocus /></Field>
        <Field label="Instructions" htmlFor="si" hint="Optional"><textarea id="si" className="textarea" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} style={{ minHeight: 70 }} /></Field>
        <Field label="Linked resource" htmlFor="sk" hint="Optional">
          <select id="sk" className="select" value={form.knowledgeItemId} onChange={(e) => setForm({ ...form, knowledgeItemId: e.target.value })}>
            <option value="">None</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
          </select>
        </Field>
        <Field label="Due within" htmlFor="sd" hint="Days after joining. Optional.">
          <div className="row" style={{ gap: 8 }}>
            <input id="sd" className="input" type="number" min={1} max={365} inputMode="numeric" style={{ width: 100 }} value={form.dueDays} onChange={(e) => setForm({ ...form, dueDays: e.target.value })} />
            <span className="subtle">days</span>
          </div>
        </Field>
        <label className="check"><input type="checkbox" checked={form.isRequired} onChange={(e) => setForm({ ...form, isRequired: e.target.checked })} /> Required step</label>
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}><X size={15} /> Cancel</button><button className="btn primary" disabled={busy || !form.title.trim() || (form.dueDays !== '' && !(Number(form.dueDays) >= 1 && Number(form.dueDays) <= 365))}>{busy ? <Spinner /> : 'Save step'}</button></div>
      </form>
    </Modal>
  );
}
