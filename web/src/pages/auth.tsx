import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound } from 'lucide-react';
import { api, setCsrf } from '../api';
import { LanguageSwitch } from '../lib/i18n';
import { Alert, BrandMark, ErrorAlert, Field, Spinner } from '../components/ui';
import { t } from '../lib/i18n';

const GOOGLE_ERRORS: Record<string, string> = {
  google_failed: 'Google sign-in could not be completed. Please try again.',
  google_unavailable: 'Google sign-in is not configured for this server.',
  google_email_unverified: 'Your Google account email is not verified.',
  link_required: 'An account with this email already exists. Sign in with your password, then connect Google from Account settings.',
  google_in_use: 'That Google account is already connected to a different Tavern account.',
  account_unavailable: 'This account is not available.',
  signin_required: 'Please sign in first.',
};

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-art" aria-hidden="true">
        <div className="auth-brand">
          <BrandMark size={32} />
          <div>
            <div className="wordmark">{t("Tavern")}</div>
            <div className="descriptor">{t("Project Knowledge Board")}</div>
          </div>
        </div>
        <div>
          <h2>{t("Every link, doc and file your project runs on — in one place.")}</h2>
          <p>{t("New teammates accept an invite and find what their role needs, without asking around.")}</p>
        </div>
        <div className="auth-points">
          <div><Check size={16} />{' '}{t("Links, uploaded files and internal docs, organized by project")}</div>
          <div><Check size={16} />{' '}{t("Role-based access, invitation links and onboarding checklists")}</div>
          <div><Check size={16} />{' '}{t("Strict separation between organizations and projects")}</div>
        </div>
      </div>
      <div className="auth-panel">
        <LanguageSwitch className="auth-lang" />
        <div className="auth-card">{children}</div>
      </div>
    </div>
  );
}

function GoogleButton({ next }: { next: string }) {
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ google: boolean }>('/auth/providers') });
  if (!providers.data?.google) return null;
  return (
    <>
      <a className="btn block" href={`/api/v1/auth/google/start?returnTo=${encodeURIComponent(next)}`}>
        <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>{t("Continue with Google")}</a>
      <div className="divider">{t("or")}</div>
    </>
  );
}

const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export function Login() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const oauthError = params.get('error');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ csrfToken: string }>('/auth/login', { body: { email, password } });
      setCsrf(r.csrfToken);
      await qc.invalidateQueries();
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1>{t("Welcome back")}</h1>
      <div style={{ marginBottom: 24 }} />
      {oauthError && <div style={{ marginBottom: 16 }}><Alert tone="danger">{t(GOOGLE_ERRORS[oauthError] ?? GOOGLE_ERRORS.google_failed!)}</Alert></div>}
      <div className="form">
        <GoogleButton next={next} />
        <form className="form" onSubmit={submit} noValidate>
          <ErrorAlert error={error} />
          <Field label={t("Email")} htmlFor="email">
            <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label={t("Password")} htmlFor="password">
            <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: -8 }}>
            <Link to="/forgot-password" style={{ fontSize: 13.5 }}>{t("Forgot password?")}</Link>
          </div>
          <button className="btn primary block" disabled={busy || !email || !password}>{busy ? <Spinner /> : t("Sign in")}</button>
        </form>
        <p className="muted" style={{ textAlign: 'center', fontSize: 14 }}>{t("New to Tavern?")}{' '}<Link to={`/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>{t("Create an account")}</Link>
        </p>
      </div>
    </AuthLayout>
  );
}

export function Register() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ csrfToken: string }>('/auth/register', { body: form });
      setCsrf(r.csrfToken);
      await qc.invalidateQueries();
      navigate(next === '/' ? '/setup' : next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const short = form.password.length > 0 && form.password.length < 10;

  return (
    <AuthLayout>
      <h1>{t("Create your account")}</h1>
      <div style={{ marginBottom: 24 }} />
      <div className="form">
        <GoogleButton next={next} />
        <form className="form" onSubmit={submit} noValidate>
          <ErrorAlert error={error} />
          <Field label={t("Your name")} htmlFor="name">
            <input id="name" className="input" autoComplete="name" value={form.displayName} onChange={set('displayName')} autoFocus />
          </Field>
          <Field label={t("Work email")} htmlFor="email">
            <input id="email" className="input" type="email" autoComplete="email" value={form.email} onChange={set('email')} />
          </Field>
          <Field label={t("Password")} htmlFor="password" hint={t("At least 10 characters.")} error={short ? t('Use at least 10 characters.') : null}>
            <input id="password" className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} aria-invalid={short} />
          </Field>
          <button className="btn primary block" disabled={busy || !form.displayName || !form.email || form.password.length < 10}>
            {busy ? <Spinner /> : t("Create account")}
          </button>
        </form>
        <p className="muted" style={{ textAlign: 'center', fontSize: 14 }}>{t("Already have an account?")}{' '}<Link to={`/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>{t("Sign in")}</Link>
        </p>
      </div>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/forgot-password', { body: { email } });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout>
      <h1>{t("Reset your password")}</h1>
      <p className="muted" style={{ marginBottom: 24 }}>{t("We'll email you a reset link.")}</p>
      {done ? (
        <div className="form">
          <Alert tone="ok">{t("If an account exists for")}{' '}<strong>{email}</strong>{t(", a reset link is on its way.")}</Alert>
          <Link to="/login" className="btn block">{t("Back to sign in")}</Link>
        </div>
      ) : (
        <form className="form" onSubmit={submit} noValidate>
          <ErrorAlert error={error} />
          <Field label={t("Email")} htmlFor="email">
            <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <button className="btn primary block" disabled={busy || !email}>{busy ? <Spinner /> : t("Send reset link")}</button>
          <Link to="/login" style={{ textAlign: 'center', fontSize: 14 }}>{t("Back to sign in")}</Link>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', { body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout>
      <h1>{t("Choose a new password")}</h1>
      <p className="muted" style={{ marginBottom: 24 }}>{t("You'll be signed out of every other device.")}</p>
      {done ? (
        <div className="form">
          <Alert tone="ok">{t("Your password has been updated.")}</Alert>
          <Link to="/login" className="btn primary block">{t("Sign in")}</Link>
        </div>
      ) : (
        <form className="form" onSubmit={submit} noValidate>
          {!token && <Alert tone="danger">{t("This link is missing its token. Open the link from your email again.")}</Alert>}
          <ErrorAlert error={error} />
          <Field label={t("New password")} htmlFor="password" hint={t("At least 10 characters.")}>
            <input id="password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
          <button className="btn primary block" disabled={busy || !token || password.length < 10}>
            {busy ? <Spinner /> : <><KeyRound size={16} />{' '}{t("Update password")}</>}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const qc = useQueryClient();
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false); // tokens are single-use; don't double-submit under StrictMode
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api('/auth/verify-email', { body: { token } })
      .then(() => {
        setState('ok');
        qc.invalidateQueries({ queryKey: ['me'] });
      })
      .catch((e) => {
        setError(e);
        setState('error');
      });
  }, [token, qc]);
  return (
    <AuthLayout>
      <h1>{t("Email verification")}</h1>
      <div style={{ marginTop: 20 }} className="form">
        {state === 'working' && <Spinner />}
        {state === 'ok' && <Alert tone="ok">{t("Your email address is verified.")}</Alert>}
        {state === 'error' && <ErrorAlert error={error} />}
        {state !== 'working' && <Link to="/" className="btn primary block">{t("Continue")}</Link>}
      </div>
    </AuthLayout>
  );
}
