import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, LogOut } from 'lucide-react';
import { api } from '../api';
import { timeAgo } from '../lib/format';
import { useMe } from '../lib/session';
import { Alert, Avatar, ErrorAlert, Field, Spinner, errorText, useToast } from '../components/ui';
import { FormSkeleton, PageHeadSkeleton } from '../components/Skeletons';

export function Account() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api('/auth/providers') });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api('/me/sessions') });
  const [name, setName] = useState(me.data?.user.displayName ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ which: string; e: unknown } | null>(null);
  if (!me.data) return <div className="content narrow"><PageHeadSkeleton /><FormSkeleton /></div>;
  const u = me.data.user;

  const run = async (which: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(which);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      toast(msg);
      return true;
    } catch (e) {
      setError({ which, e });
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="content narrow">
      <div className="page-head"><div><h1>Account settings</h1><p className="lede">{u.email}</p></div></div>
      {params.get('linked') === 'google' && <div style={{ marginBottom: 16 }}><Alert tone="ok">Google is now connected to your account.</Alert></div>}
      <div className="stack" style={{ gap: 24 }}>
        <form className="card card-pad form" onSubmit={(e: FormEvent) => { e.preventDefault(); run('name', () => api('/me', { method: 'PATCH', body: { displayName: name } }), 'Profile updated'); }}>
          <h2>Profile</h2>
          {error?.which === 'name' && <ErrorAlert error={error.e} />}
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Avatar id={u.id} name={u.displayName} url={u.avatarUrl} size="lg" />
            <div style={{ flex: 1 }}><Field label="Display name" htmlFor="dn"><input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field></div>
            <button className="btn primary" disabled={busy !== null || !name.trim() || name === u.displayName}>{busy === 'name' ? <Spinner /> : 'Save'}</button>
          </div>
          <div className="row subtle">Email: {u.email} {u.emailVerified ? <span className="badge ok">Verified</span> : <span className="badge warn">Not verified</span>}</div>
        </form>

        <form className="card card-pad form" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (await run('pw', () => api('/me/password', { body: u.hasPassword ? pw : { newPassword: pw.newPassword } }), 'Password updated — other devices were signed out')) setPw({ currentPassword: '', newPassword: '' }); }}>
          <div><h2>{u.hasPassword ? 'Change password' : 'Add a password'}</h2>{!u.hasPassword && <p className="muted" style={{ marginTop: 4 }}>You sign in with Google. Add a password to also sign in with your email.</p>}</div>
          {error?.which === 'pw' && <ErrorAlert error={error.e} />}
          {u.hasPassword && <Field label="Current password" htmlFor="cp"><input id="cp" className="input" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>}
          <Field label="New password" htmlFor="np" hint="At least 10 characters. Your other sessions will be signed out."><input id="np" className="input" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy !== null || pw.newPassword.length < 10}>{busy === 'pw' ? <Spinner /> : 'Update password'}</button></div>
        </form>

        <div className="card card-pad form">
          <h2>Sign-in methods</h2>
          <div className="row">
            <strong style={{ flex: 1 }}>Google</strong>
            {u.googleLinked ? <span className="badge ok">Connected</span>
              : providers.data?.google ? <a className="btn sm" href="/api/v1/auth/google/start?mode=link">Connect Google</a>
              : <span className="subtle">Not available on this server</span>}
          </div>
          <p className="subtle">Single sign-on (SAML/OIDC) for organizations is planned for a later release.</p>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Active sessions</h2>
            <button className="btn sm" onClick={() => run('revoke', () => api('/me/sessions/revoke-others', { method: 'POST' }), 'Signed out of other devices')} disabled={busy !== null}><LogOut size={14} /> Sign out other devices</button>
          </div>
          <div>
            {sessions.data?.data.map((s: any) => (
              <div key={s.id} className="row" style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border-muted)' }}>
                <Laptop size={18} className="muted" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontSize: 14 }}>{s.userAgent || 'Unknown device'}</div>
                  <div className="subtle">Signed in {timeAgo(s.createdAt)} · last active {timeAgo(s.lastSeenAt)}</div>
                </div>
                {s.current ? <span className="badge accent">This device</span> : (
                  <button className="btn ghost sm" onClick={async () => { try { await api(`/me/sessions/${s.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['sessions'] }); } catch (e) { toast(errorText(e), 'error'); } }}>Sign out</button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
