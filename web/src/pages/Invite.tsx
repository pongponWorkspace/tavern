import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { api } from '../api';
import { useMe } from '../lib/session';
import { AuthLayout } from './auth';
import { Alert, ErrorAlert, Spinner } from '../components/ui';
import { AppSplash } from '../components/Skeletons';
import { fullDate } from '../lib/format';
import { t } from '../lib/i18n';

export function AcceptInvite() {
  const { token = '' } = useParams();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({ queryKey: ['invite', token], queryFn: () => api(`/invitations/preview`, { query: { token } }) });
  const here = `/invite/${token}`;

  if (preview.isLoading || me.isLoading) return <AppSplash />;
  const p = preview.data;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ tenantId: string; projectId: string | null }>('/invitations/accept', { body: { token } });
      await qc.invalidateQueries();
      navigate(r.projectId ? `/p/${r.projectId}/onboarding` : `/t/${r.tenantId}`, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      {!p?.valid ? (
        <div className="form">
          <h1>{t("Invitation unavailable")}</h1>
          <Alert tone="warn">{p?.message ?? t("This invitation link is no longer valid.")}</Alert>
          <Link to="/" className="btn block">{t("Go to Tavern")}</Link>
        </div>
      ) : (
        <div className="form">
          <div className="empty-icon" style={{ marginBottom: 4 }}><MailCheck size={22} /></div>
          <h1>{t("Join")}{' '}{p.projectName ?? p.tenantName}</h1>
          <p className="muted">
            <strong>{p.invitedBy}</strong>{' '}{t("invited you to")}{' '}{p.projectName ? <>{t("the")}{' '}<strong>{p.projectName}</strong>{' '}{t("project in")}{' '}<strong>{p.tenantName}</strong></> : <strong>{p.tenantName}</strong>}{' '}{t("as")}{' '}<strong>{p.roleLabel}</strong>.
          </p>
          <p className="subtle">{t("Link expires")}{' '}{fullDate(p.expiresAt)}.{p.emailRestricted && t(" This invitation is for a specific email address.")}</p>
          <ErrorAlert error={error} />
          {me.data ? (
            <>
              <button className="btn primary block" onClick={accept} disabled={busy}>{busy ? <Spinner /> : t("Accept invitation")}</button>
              <p className="subtle" style={{ textAlign: 'center' }}>{t("Signed in as")}{' '}{me.data.user.email}</p>
            </>
          ) : (
            <>
              <Link className="btn primary block" to={`/register?next=${encodeURIComponent(here)}`}>{t("Create an account to accept")}</Link>
              <Link className="btn block" to={`/login?next=${encodeURIComponent(here)}`}>{t("I already have an account")}</Link>
            </>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
