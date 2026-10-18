import { useState, type FormEvent } from 'react';
import { NavLink, Navigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Link2, Lock } from 'lucide-react';
import { api, type TenantRole } from '../../api';
import { bytes, fullDate, TENANT_ROLE_LABEL, timeAgo } from '../../lib/format';
import { useMe } from '../../lib/session';
import { AuditLog } from '../../components/AuditLog';
import { Avatar, ConfirmDialog, TenantRoleBadge, Empty, ErrorAlert, Field, Spinner, errorText, useToast } from '../../components/ui';
import { PageHeadSkeleton, TableSkeleton, TabsSkeleton } from '../../components/Skeletons';
import { InviteModal, InviteStatus } from '../project/Members';
import { TenantRoleTable } from '../../components/RoleTables';
import { NotFound } from '../NotFound';

export function TenantSettings() {
  const { tenantId = '', tab } = useParams();
  const me = useMe();
  const tenant = me.data?.tenants.find((t) => t.id === tenantId);
  const q = useQuery({ queryKey: ['tenant', tenantId], queryFn: () => api(`/tenants/${tenantId}`), enabled: Boolean(tenant) });
  if (!tenant) return <NotFound what="organization" />;
  if (q.isLoading) return <div className="content"><PageHeadSkeleton /><TabsSkeleton n={4} /><TableSkeleton rows={5} cols={5} /></div>;
  if (q.error || !q.data) return <div className="content"><ErrorAlert error={q.error} /></div>;
  const perms = q.data.permissions;
  // Every organization page lives here as a tab; each shows only to people allowed to use it.
  const tabs = [
    { key: 'general', label: 'General', show: perms.manageSettings },
    { key: 'members', label: 'Members', show: perms.manageMembers },
    { key: 'invitations', label: 'Invitations', show: perms.manageMembers },
    { key: 'roles', label: 'Roles & permissions', show: true },
    { key: 'audit', label: 'Audit log', show: perms.viewAudit },
  ].filter((t) => t.show);
  if (!tab || !tabs.some((t) => t.key === tab)) return <Navigate to={`/t/${tenantId}/settings/${tabs[0].key}`} replace />;
  const base = `/t/${tenantId}/settings`;
  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>{tenant.name}</h1>
        </div>
      </div>
      <nav className="tabs" aria-label="Organization settings">
        {tabs.map((t) => <NavLink key={t.key} to={`${base}/${t.key}`}>{t.label}</NavLink>)}
      </nav>
      {tab === 'roles' && (
        <>
          {!perms.manageRoles && <p className="subtle" style={{ marginBottom: 14 }}>Only the Owner can change this.</p>}
          <TenantRoleTable tenantId={tenantId} value={q.data.rolePermissions} editable={perms.manageRoles} myRole={tenant.role} />
        </>
      )}
      {tab === 'general' && <General tenant={q.data} />}
      {tab === 'members' && <TenantMembers tenant={q.data} />}
      {tab === 'invitations' && <TenantInvites tenant={q.data} />}
      {tab === 'audit' && (
        <>
          <AuditLog endpoint={`/tenants/${tenantId}/audit-logs`} />
        </>
      )}
    </div>
  );
}

function General({ tenant }: { tenant: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(tenant.name);
  const [allow, setAllow] = useState(tenant.settings.projectInvitesAddTenantMembers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/tenants/${tenant.id}`, { method: 'PATCH', body: { name, projectInvitesAddTenantMembers: allow } });
      await qc.invalidateQueries();
      toast('Organization updated');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 24, maxWidth: 720 }}>
      <form className="card card-pad form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="Organization name" htmlFor="on"><input id="on" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <label className="check">
          <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
          <span><strong>Project invitations can bring in new people</strong><br /><span className="subtle">Accepting a project invitation also adds the person to this organization.</span></span>
        </label>
        <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy || name.trim().length < 2}>{busy ? <Spinner /> : 'Save'}</button></div>
      </form>
      <StorageCard tenantId={tenant.id} />
      {tenant.permissions.transferOwnership && <TransferOwnership tenant={tenant} />}
    </div>
  );
}

function StorageCard({ tenantId }: { tenantId: string }) {
  const q = useQuery({ queryKey: ['storage', tenantId], queryFn: () => api(`/tenants/${tenantId}/storage`) });
  if (!q.data) return null;
  const { used, limit, files, byProject } = q.data;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className="card card-pad stack">
      <div className="row"><h2>Storage</h2><span className="spacer" /><span className="subtle">{files} {files === 1 ? 'file' : 'files'}</span></div>
      <div>
        <div className="row" style={{ marginBottom: 6 }}><strong>{bytes(used)}</strong><span className="subtle">of {bytes(limit)}</span><span className="spacer" /><span className="subtle">{pct}%</span></div>
        <div className={`progress ${pct >= 90 ? 'danger' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used"><span style={{ width: `${Math.max(pct, used ? 1 : 0)}%` }} /></div>
      </div>
      {byProject.length > 0 && (
        <table className="table">
          <tbody>
            {byProject.map((p: any) => (
              <tr key={p.id}><td>{p.name}</td><td className="muted" style={{ textAlign: 'right' }}>{p.files} {p.files === 1 ? 'file' : 'files'}</td><td style={{ textAlign: 'right', width: 90 }}>{bytes(p.used)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TransferOwnership({ tenant }: { tenant: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const members = useQuery({ queryKey: ['tenant-members', tenant.id], queryFn: () => api(`/tenants/${tenant.id}/members`) });
  const [target, setTarget] = useState('');
  const [confirm, setConfirm] = useState(false);
  const candidates = (members.data?.data ?? []).filter((m: any) => m.role !== 'owner' && m.status === 'active');
  const name = candidates.find((m: any) => m.userId === target)?.displayName;
  return (
    <div className="card card-pad form">
      <div><h2>Transfer ownership</h2><p className="muted" style={{ marginTop: 4 }}>You'll become an Admin.</p></div>
      <div className="row">
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="New owner">
          <option value="">Choose a member…</option>
          {candidates.map((m: any) => <option key={m.userId} value={m.userId}>{m.displayName} ({m.email})</option>)}
        </select>
        <button className="btn danger" disabled={!target} onClick={() => setConfirm(true)}>Transfer</button>
      </div>
      <ConfirmDialog open={confirm} title={`Make ${name} the owner?`} confirmLabel="Transfer ownership" danger onClose={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            await api(`/tenants/${tenant.id}/transfer-ownership`, { body: { userId: target } });
            await qc.invalidateQueries();
            toast('Ownership transferred');
          } catch (e) {
            toast(errorText(e), 'error');
          }
          setConfirm(false);
        }}>
        Only the owner can transfer ownership or delete the organization. This takes effect immediately.
      </ConfirmDialog>
    </div>
  );
}

function TenantMembers({ tenant }: { tenant: any }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [removing, setRemoving] = useState<any | null>(null);
  const q = useQuery({ queryKey: ['tenant-members', tenant.id], queryFn: () => api(`/tenants/${tenant.id}/members`) });
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['tenant-members', tenant.id] });
      toast(msg);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  if (q.isLoading) return <TableSkeleton rows={5} cols={6} />;
  const isOwner = tenant.myRole === 'owner';
  const canEdit = (m: any) => m.userId !== me.data?.user.id && m.role !== 'owner' && (isOwner || m.role === 'member');
  return (
    <>
      <ErrorAlert error={q.error} />
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>Person</th><th>Role</th><th>Projects</th><th>Status</th><th>Joined</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {q.data.data.map((m: any) => (
              <tr key={m.userId}>
                <td><div className="person"><Avatar id={m.userId} name={m.displayName} url={m.avatarUrl} /><div><div className="person-name">{m.displayName}</div><div className="person-email">{m.email}</div></div></div></td>
                <td>
                  {canEdit(m) && isOwner ? (
                    <select className="select" value={m.role} aria-label={`Role for ${m.displayName}`}
                      onChange={(e) => run(() => api(`/tenants/${tenant.id}/members/${m.userId}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated')}>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </select>
                  ) : <TenantRoleBadge role={m.role as TenantRole} />}
                </td>
                <td className="muted">{m.projectCount}</td>
                <td>{m.status === 'active' ? <span className="badge ok">Active</span> : <span className="badge warn">Suspended</span>}</td>
                <td className="muted" title={fullDate(m.joinedAt)}>{timeAgo(m.joinedAt)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {canEdit(m) && (
                    <>
                      <button className="btn ghost sm" onClick={() => run(() => api(`/tenants/${tenant.id}/members/${m.userId}`, { method: 'PATCH', body: { status: m.status === 'active' ? 'suspended' : 'active' } }), m.status === 'active' ? 'Suspended' : 'Reactivated')}>
                        {m.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </button>
                      <button className="btn ghost sm" onClick={() => setRemoving(m)}>Remove</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog open={Boolean(removing)} title={`Remove ${removing?.displayName}?`} confirmLabel="Remove from organization" danger onClose={() => setRemoving(null)}
        onConfirm={() => { const m = removing; setRemoving(null); run(() => api(`/tenants/${tenant.id}/members/${m.userId}`, { method: 'DELETE' }), `${m.displayName} removed`); }}>
        They'll lose access to {tenant.name} and every project in it, immediately.
      </ConfirmDialog>
    </>
  );
}

function TenantInvites({ tenant }: { tenant: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const q = useQuery({ queryKey: ['tenant-invites', tenant.id], queryFn: () => api(`/tenants/${tenant.id}/invitations`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['tenant-invites', tenant.id] });
  const roles = [
    { value: 'member', label: 'Member', hint: 'Joins the organization; needs to be added to projects separately.' },
    ...(tenant.myRole === 'owner' ? [{ value: 'admin', label: 'Admin', hint: 'Manages members, workspaces and projects — but not project content.' }] : []),
  ];
  return (
    <>
      <div className="section-head">
        <p className="subtle">Organization invitations add people to {tenant.name}. To give someone access to a project, invite them from that project's Members tab.</p>
        <button className="btn primary" onClick={() => setInviting(true)}><Link2 size={15} /> Invite to organization</button>
      </div>
      <div className="card table-wrap">
        {q.data?.data.length === 0 ? <Empty icon={<Link2 size={22} />} title="No organization invitations" /> : (
          <table className="table">
            <thead><tr><th>Role</th><th>Restriction</th><th>Uses</th><th>Status</th><th>Expires</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {q.data?.data.map((i: any) => (
                <tr key={i.id}>
                  <td><strong>{TENANT_ROLE_LABEL[i.role as TenantRole]}</strong></td>
                  <td className="muted">{i.email ?? (i.allowedDomain ? `@${i.allowedDomain}` : 'Anyone with the link')}</td>
                  <td className="muted">{i.useCount}/{i.maxUses}</td>
                  <td><InviteStatus status={i.status} /></td>
                  <td className="muted">{timeAgo(i.expiresAt)}</td>
                  <td style={{ textAlign: 'right' }}>{i.status === 'active' && <button className="btn ghost sm" onClick={async () => { try { await api(`/invitations/${i.id}/revoke`, { method: 'POST' }); refresh(); toast('Invitation revoked'); } catch (e) { toast(errorText(e), 'error'); } }}><Ban size={14} /> Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <InviteModal open={inviting} onClose={() => setInviting(false)} endpoint={`/tenants/${tenant.id}/invitations`} scopeName={tenant.name} roles={roles} defaultRole="member" onCreated={refresh} />
    </>
  );
}
