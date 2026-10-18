import { useEffect, useState, type FormEvent } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Copy, Link2, Search, UserMinus, UserPlus, X } from 'lucide-react';
import { api, type ProjectRole } from '../../api';
import { fullDate, PROJECT_ROLE_HINT, PROJECT_ROLE_LABEL, timeAgo } from '../../lib/format';
import { useMe } from '../../lib/session';
import { Avatar, ConfirmDialog, Empty, ErrorAlert, Field, Modal, Spinner, TenantRoleBadge, errorText, useToast } from '../../components/ui';
import { PageHeadSkeleton, Skel, TableSkeleton } from '../../components/Skeletons';
import { useProject } from './ProjectLayout';

const ROLES: ProjectRole[] = ['project_admin', 'maintainer', 'member', 'viewer'];

export function InviteStatus({ status }: { status: string }) {
  const tone = status === 'active' ? 'ok' : status === 'revoked' || status === 'expired' ? 'danger' : '';
  const label = { active: 'Active', revoked: 'Revoked', expired: 'Expired', accepted: 'Accepted', exhausted: 'Used up' }[status] ?? status;
  return <span className={`badge ${tone}`}>{label}</span>;
}

/** Shared "create invitation link" form (project or tenant scope). */
export function InviteModal({ open, onClose, endpoint, roles, defaultRole, scopeName, onCreated }: {
  open: boolean; onClose: () => void; endpoint: string; roles: { value: string; label: string; hint?: string }[]; defaultRole: string; scopeName: string; onCreated: () => void;
}) {
  const [form, setForm] = useState({ role: defaultRole, expiresInDays: 7, maxUses: 1, email: '', allowedDomain: '' });
  const [result, setResult] = useState<{ url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const close = () => {
    setResult(null);
    setError(null);
    setForm({ role: defaultRole, expiresInDays: 7, maxUses: 1, email: '', allowedDomain: '' });
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api(endpoint, {
        body: { role: form.role, expiresInDays: Number(form.expiresInDays), maxUses: Number(form.maxUses), email: form.email || undefined, allowedDomain: form.allowedDomain || undefined },
      });
      setResult(r);
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result!.url);
      toast('Link copied');
    } catch {
      toast('Select the link and copy it manually', 'error');
    }
  };
  const roleHint = roles.find((r) => r.value === form.role)?.hint;
  return (
    <Modal open={open} onClose={close} title={result ? 'Invitation link ready' : `Invite people to ${scopeName}`}>
      {result ? (
        <div className="form">
          <p className="muted">It's shown only once, so copy it now.</p>
          <div className="copy-field">
            <input className="input" readOnly value={result.url} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
            <button className="btn primary" onClick={copy}><Copy size={15} /> Copy</button>
          </div>
          {form.email && <p className="subtle">We also emailed it to {form.email}.</p>}
          <div className="row"><span className="spacer" /><button className="btn" onClick={close}>Done</button></div>
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          <ErrorAlert error={error} />
          <Field label="Role" htmlFor="ir" hint={roleHint}>
            <select id="ir" className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>
          <div className="form-row">
            <Field label="Expires after" htmlFor="ie">
              <select id="ie" className="select" value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: Number(e.target.value) })}>
                {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
              </select>
            </Field>
            <Field label="Can be used" htmlFor="iu">
              <select id="iu" className="select" value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: Number(e.target.value) })} disabled={Boolean(form.email)}>
                {[1, 5, 10, 25, 50, 100].map((n) => <option key={n} value={n}>{n === 1 ? 'Once' : `Up to ${n} times`}</option>)}
              </select>
            </Field>
          </div>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>Restrict who can accept</summary>
            <div className="form" style={{ marginTop: 12 }}>
              <Field label="Specific email" htmlFor="iem" hint="We'll email it. Only this address can accept.">
                <input id="iem" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" />
              </Field>
              <Field label="Email domain" htmlFor="idm" hint="Only addresses at this domain can accept.">
                <input id="idm" className="input" value={form.allowedDomain} onChange={(e) => setForm({ ...form, allowedDomain: e.target.value })} placeholder="company.com" />
              </Field>
            </div>
          </details>
          <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={close}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? <Spinner /> : <><Link2 size={15} /> Create link</>}</button></div>
        </form>
      )}
    </Modal>
  );
}

export function MembersPage() {
  const p = useProject();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<any | null>(null);
  const members = useQuery({ queryKey: ['members', p.id], queryFn: () => api(`/projects/${p.id}/members`) });
  const invites = useQuery({ queryKey: ['invites', p.id], queryFn: () => api(`/projects/${p.id}/invitations`) });
  const report = useQuery({ queryKey: ['onboarding-report', p.id], queryFn: () => api(`/projects/${p.id}/onboarding/report`) });
  const progress = new Map<string, any>((report.data?.data ?? []).map((r: any) => [r.userId, r]));

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['members', p.id] });
    qc.invalidateQueries({ queryKey: ['invites', p.id] });
    qc.invalidateQueries({ queryKey: ['people', p.id] });
  };
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      refresh();
      toast(msg);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  if (members.isLoading) return <div><PageHeadSkeleton action /><TableSkeleton rows={5} cols={5} /></div>;

  return (
    <div className="stack" style={{ gap: 28 }}>
      <section>
        <div className="section-head">
          <div><h2>Members <span className="subtle" style={{ fontWeight: 400 }}>{members.data?.data.length}</span></h2></div>
          <div className="row">
            <button className="btn" onClick={() => setAdding(true)} disabled={!p.writable}><UserPlus size={15} /> Add from organization</button>
            <button className="btn primary" onClick={() => setInviting(true)} disabled={!p.writable}><Link2 size={15} /> Invite with link</button>
          </div>
        </div>
        <ErrorAlert error={members.error} />
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Person</th><th>Role</th><th>Onboarding</th><th>Joined</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {members.data?.data.map((m: any) => {
                const pr = progress.get(m.userId);
                const isMe = m.userId === me.data?.user.id;
                return (
                  <tr key={m.userId}>
                    <td>
                      <div className="person">
                        <Avatar id={m.userId} name={m.displayName} url={m.avatarUrl} />
                        <div style={{ minWidth: 0 }}><div className="person-name">{m.displayName}{isMe && <span className="subtle"> (you)</span>}</div><div className="person-email">{m.email}</div></div>
                      </div>
                    </td>
                    <td>
                      <select className="select" value={m.role} disabled={!p.writable}
                        aria-label={`Role for ${m.displayName}`}
                        onChange={(e) => run(() => api(`/projects/${p.id}/members/${m.userId}`, { method: 'PATCH', body: { role: e.target.value } }), `${m.displayName} is now ${PROJECT_ROLE_LABEL[e.target.value as ProjectRole]}`)}>
                        {ROLES.map((r) => <option key={r} value={r}>{PROJECT_ROLE_LABEL[r]}</option>)}
                      </select>
                    </td>
                    <td>
                      {pr && pr.required > 0 ? (
                        <div style={{ minWidth: 110 }}>
                          <div className="progress success" style={{ height: 6 }}><span style={{ width: `${Math.round((pr.completed / pr.required) * 100)}%` }} /></div>
                          <span className="subtle">{pr.completed}/{pr.required}</span>
                          {pr.overdue > 0 && <span className="badge danger" style={{ marginLeft: 6 }}>{pr.overdue} overdue</span>}
                        </div>
                      ) : <span className="subtle">—</span>}
                    </td>
                    <td className="muted" title={fullDate(m.joinedAt)}>{timeAgo(m.joinedAt)}{m.invitedBy && <div className="subtle">by {m.invitedBy}</div>}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn ghost sm" onClick={() => setRemoving(m)} disabled={!p.writable} aria-label={`Remove ${m.displayName}`}><UserMinus size={15} /> Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="section-head"><div><h2>Invitation links</h2></div></div>
        <div className="card table-wrap">
          {invites.data?.data.length === 0 ? (
            <Empty icon={<Link2 size={22} />} title="No invitations yet" />
          ) : (
            <table className="table">
              <thead><tr><th>Role</th><th>Restriction</th><th>Uses</th><th>Status</th><th>Expires</th><th>Created</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {invites.data?.data.map((i: any) => (
                  <tr key={i.id}>
                    <td><strong>{PROJECT_ROLE_LABEL[i.role as ProjectRole]}</strong></td>
                    <td className="muted">{i.email ?? (i.allowedDomain ? `@${i.allowedDomain}` : 'Anyone with the link')}</td>
                    <td className="muted">{i.useCount}/{i.maxUses}</td>
                    <td><InviteStatus status={i.status} /></td>
                    <td className="muted" title={fullDate(i.expiresAt)}>{timeAgo(i.expiresAt)}</td>
                    <td className="muted">{i.createdBy?.displayName}<div className="subtle">{timeAgo(i.createdAt)}</div></td>
                    <td style={{ textAlign: 'right' }}>
                      {i.status === 'active' && <button className="btn ghost sm" onClick={() => run(() => api(`/invitations/${i.id}/revoke`, { method: 'POST' }), 'Invitation revoked')}><Ban size={14} /> Revoke</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <InviteModal open={inviting} onClose={() => setInviting(false)} endpoint={`/projects/${p.id}/invitations`} scopeName={p.name}
        roles={ROLES.map((r) => ({ value: r, label: PROJECT_ROLE_LABEL[r], hint: PROJECT_ROLE_HINT[r] }))} defaultRole="member" onCreated={refresh} />
      <AddMemberModal open={adding} onClose={() => setAdding(false)} onAdded={refresh} />
      <ConfirmDialog open={Boolean(removing)} title={`Remove ${removing?.displayName}?`} confirmLabel="Remove access" danger onClose={() => setRemoving(null)}
        onConfirm={() => { const m = removing; setRemoving(null); run(() => api(`/projects/${p.id}/members/${m.userId}`, { method: 'DELETE' }), `${m.displayName} removed`); }}>
        They lose access to this project's knowledge and files immediately. Their contributions stay.
      </ConfirmDialog>
    </div>
  );
}

function AddMemberModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Add people from your organization">
      {open && <AddMemberForm onClose={onClose} onAdded={onAdded} />}
    </Modal>
  );
}

interface Candidate { id: string; displayName: string; email: string; avatarUrl: string | null; tenantRole: 'owner' | 'admin' | 'member' }

/** Search the organization's members who aren't on this project yet, pick one or more, choose a role. */
function AddMemberForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const p = useProject();
  const toast = useToast();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Map<string, Candidate>>(new Map());
  const [role, setRole] = useState<ProjectRole>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(t);
  }, [text]);
  const res = useQuery({
    queryKey: ['member-candidates', p.id, q],
    queryFn: () => api<{ data: Candidate[] }>(`/projects/${p.id}/member-candidates`, { query: { q, limit: 30 } }),
    placeholderData: keepPreviousData,
  });
  const list = res.data?.data ?? [];

  const toggle = (c: Candidate) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(c.id)) next.delete(c.id);
      else next.set(c.id, c);
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${p.id}/members`, { body: { userIds: [...picked.keys()], role } });
      onAdded();
      const names = [...picked.values()].map((c) => c.displayName);
      toast(names.length === 1 ? `${names[0]} added as ${PROJECT_ROLE_LABEL[role]}` : `${names.length} people added as ${PROJECT_ROLE_LABEL[role]}`);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <ErrorAlert error={error} />
      <div className="search">
        <Search size={16} />
        <input
          className="input"
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search by name or email"
          aria-label="Search organization members"
          aria-controls="candidate-list"
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
        />
      </div>

      {picked.size > 0 && (
        <div className="row wrap" style={{ gap: 6 }} aria-label="Selected people">
          {[...picked.values()].map((c) => (
            <span key={c.id} className="tag">
              {c.displayName}
              <button type="button" className="tag-x" onClick={() => toggle(c)} aria-label={`Remove ${c.displayName}`}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}

      <div className="picker" id="candidate-list" role="group" aria-label="Organization members" aria-busy={res.isFetching}>
        {res.isLoading ? (
          [0, 1, 2, 3].map((i) => (
            <div key={i} className="picker-row" aria-hidden="true">
              <Skel w={16} h={16} r={4} /><Skel w={28} h={28} r={999} />
              <div className="stack" style={{ gap: 6, flex: 1 }}><Skel w="40%" h={12} /><Skel w="55%" h={10} /></div>
            </div>
          ))
        ) : list.length === 0 ? (
          <div className="picker-empty">
            {q ? <>No one in {p.tenant.name} matches “{q}”. To add someone new, use <strong>Invite with link</strong>.</> : <>Everyone in {p.tenant.name} is already on this project.</>}
          </div>
        ) : (
          list.map((c) => {
            const on = picked.has(c.id);
            return (
              <label key={c.id} className={`picker-row ${on ? 'on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => toggle(c)} />
                <Avatar id={c.id} name={c.displayName} url={c.avatarUrl} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="person-name ellipsis" style={{ display: 'block' }}>{c.displayName}</span>
                  <span className="person-email ellipsis" style={{ display: 'block' }}>{c.email}</span>
                </span>
                {c.tenantRole !== 'member' && <TenantRoleBadge role={c.tenantRole} />}
              </label>
            );
          })
        )}
      </div>

      <Field label="Project role" htmlFor="ar" hint={PROJECT_ROLE_HINT[role]}>
        <select id="ar" className="select" value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>{ROLES.map((r) => <option key={r} value={r}>{PROJECT_ROLE_LABEL[r]}</option>)}</select>
      </Field>
      <div className="row">
        <span className="subtle">{picked.size ? `${picked.size} selected` : 'Select one or more people'}</span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || picked.size === 0}>
          {busy ? <Spinner /> : picked.size > 1 ? `Add ${picked.size} people` : 'Add to project'}
        </button>
      </div>
    </form>
  );
}
