// Authentication: login, sessions, CSRF, password reset lifecycle, and the
// Google OAuth callback's state validation (AC-011).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmac, sha256 } from '../src/lib/crypto.js';
import {
  APP_ORIGIN,
  PASSWORD,
  call,
  count,
  createUser,
  get,
  login,
  one,
  patch,
  pool,
  post,
  query,
  useTestApp,
  type TestUser,
} from './helpers.js';

useTestApp();

let alice: TestUser;

beforeEach(async () => {
  alice = await createUser({ email: 'alice@example.test', name: 'Alice' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const loginReq = (email: string, password: string, headers: Record<string, string> = {}) =>
  call('POST', '/api/v1/auth/login', { body: { email, password }, headers });

const stripRequestId = (body: any) => ({ ...body, error: { ...body.error, requestId: undefined } });

describe('login', () => {
  it('wrong password, unknown email and suspended account all get the same generic 401', async () => {
    const suspended = await createUser({ email: 'sus@example.test', status: 'suspended' });
    const responses = [
      await loginReq(alice.email, 'not-the-password'),
      await loginReq('nobody@example.test', 'not-the-password'),
      await loginReq(suspended.email, PASSWORD),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Email or password is incorrect.' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const bodies = responses.map((r) => JSON.stringify(stripRequestId(r.body)));
    expect(new Set(bodies).size).toBe(1);
    expect(await count('SELECT count(*) FROM sessions')).toBe(0);
  });

  it('is case-insensitive on email and sets a hardened session cookie', async () => {
    const res = await loginReq('ALICE@Example.TEST', PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.csrfToken).toEqual(expect.any(String));
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/^tavern_sid=/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//);
  });

  it('each login gets a fresh session; tokens are stored only as hashes', async () => {
    const a = await login(alice.email);
    const b = await login(alice.email);
    expect(a.cookie).not.toBe(b.cookie);
    expect(a.csrf).not.toBe(b.csrf);
    const rows = (await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [alice.id])).rows;
    expect(rows).toHaveLength(2);
    const tokens = [a, b].map((s) => s.cookie.split('=')[1]);
    expect(rows.map((r) => r.token_hash).sort()).toEqual(tokens.map((t) => sha256(t)).sort());
    expect(JSON.stringify(rows)).not.toContain(tokens[0]);
    for (const s of [a, b]) expect((await get(s, '/api/v1/me')).status).toBe(200);
  });

  it('logout revokes the session server-side', async () => {
    const s = await login(alice.email);
    expect((await post(s, '/api/v1/auth/logout')).status).toBe(200);
    expect((await get(s, '/api/v1/me')).status).toBe(401);
  });

  it('unauthenticated and forged-cookie requests get 401', async () => {
    expect((await get(null, '/api/v1/me')).status).toBe(401);
    const forged = await call('GET', '/api/v1/me', { headers: { cookie: 'tavern_sid=forged-session-token' } });
    expect(forged.status).toBe(401);
    expect((await call('GET', '/api/v1/tenants')).status).toBe(401);
  });

  it('expired sessions are rejected', async () => {
    const s = await login(alice.email);
    await query(pool, `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [alice.id]);
    expect((await get(s, '/api/v1/me')).status).toBe(401);
  });
});

describe('register', () => {
  it('creates an account, a session and a verification email; duplicates are rejected', async () => {
    const res = await post(null, '/api/v1/auth/register', { email: 'Bob@Example.test', password: 'long-enough-pw', displayName: 'Bob' });
    expect(res.status).toBe(201);
    expect(await one(pool, `SELECT email, email_verified_at FROM users WHERE email = 'bob@example.test'`)).toEqual({ email: 'bob@example.test', email_verified_at: null });
    expect(await count(`SELECT count(*) FROM email_outbox WHERE to_email = 'bob@example.test'`)).toBe(1);
    const dup = await post(null, '/api/v1/auth/register', { email: 'BOB@example.test', password: 'long-enough-pw', displayName: 'Bob 2' });
    expect(dup.status).toBe(409);
    expect((await post(null, '/api/v1/auth/register', { email: 'c@example.test', password: 'short', displayName: 'C' })).status).toBe(422);
  });
});

describe('CSRF protection', () => {
  it('mutation with a session cookie but no x-csrf-token → 403 CSRF_FAILED', async () => {
    const s = await login(alice.email);
    const res = await post(s, '/api/v1/tenants', { name: 'New Org' }, { csrf: null });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
    expect(await count('SELECT count(*) FROM tenants')).toBe(0);
  });

  it('wrong or another session\'s token → 403', async () => {
    const s = await login(alice.email);
    const other = await login((await createUser()).email);
    for (const csrf of ['wrong-token', other.csrf, '', s.csrf + 'x']) {
      const res = await post(s, '/api/v1/tenants', { name: 'New Org' }, { csrf });
      expect(res.status, csrf).toBe(403);
      expect(res.body.error.code).toBe('CSRF_FAILED');
    }
    expect((await patch(s, '/api/v1/me', { displayName: 'Hacked' }, { csrf: 'nope' })).status).toBe(403);
    expect((await call('DELETE', '/api/v1/me/sessions/00000000-0000-0000-0000-000000000000', { as: s, csrf: null })).status).toBe(403);
    expect(await count('SELECT count(*) FROM tenants')).toBe(0);
    expect((await one(pool, 'SELECT display_name FROM users WHERE id = $1', [alice.id])).display_name).toBe('Alice');
  });

  it('a foreign Origin is rejected even with a valid token', async () => {
    const s = await login(alice.email);
    const res = await post(s, '/api/v1/tenants', { name: 'New Org' }, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
    // Lookalike origins are not accepted either.
    expect((await post(s, '/api/v1/tenants', { name: 'New Org' }, { headers: { origin: 'http://localhost:5173.evil.example' } })).status).toBe(403);
    // Unauthenticated endpoints check Origin too (login CSRF).
    expect((await loginReq(alice.email, PASSWORD, { origin: 'https://evil.example' })).status).toBe(403);
    expect(await count('SELECT count(*) FROM tenants')).toBe(0);
  });

  it('correct token and same Origin succeed; GET needs no token', async () => {
    const s = await login(alice.email);
    expect((await post(s, '/api/v1/tenants', { name: 'New Org' }, { headers: { origin: APP_ORIGIN } })).status).toBe(201);
    expect((await get(s, '/api/v1/tenants', { csrf: null })).status).toBe(200);
  });
});

describe('password reset', () => {
  const tokenFromOutbox = async (email: string) => {
    const row = await one(pool, `SELECT body_text FROM email_outbox WHERE to_email = $1 ORDER BY created_at DESC LIMIT 1`, [email]);
    return /reset-password\?token=([\w-]+)/.exec(row.body_text)![1];
  };

  it('forgot-password returns the same body for unknown and known emails', async () => {
    const known = await post(null, '/api/v1/auth/forgot-password', { email: alice.email });
    const unknown = await post(null, '/api/v1/auth/forgot-password', { email: 'ghost@example.test' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(await count('SELECT count(*) FROM email_outbox')).toBe(1);
  });

  it('reset token is single-use, hashed at rest, and revokes existing sessions', async () => {
    const s1 = await login(alice.email);
    const s2 = await login(alice.email);
    await post(null, '/api/v1/auth/forgot-password', { email: alice.email });
    const token = await tokenFromOutbox(alice.email);
    expect(JSON.stringify((await pool.query('SELECT * FROM email_tokens')).rows)).not.toContain(token);

    const res = await post(null, '/api/v1/auth/reset-password', { token, password: 'brand-new-password' });
    expect(res.status).toBe(200);
    for (const s of [s1, s2]) expect((await get(s, '/api/v1/me')).status).toBe(401);
    expect((await loginReq(alice.email, PASSWORD)).status).toBe(401);
    expect((await loginReq(alice.email, 'brand-new-password')).status).toBe(200);

    const replay = await post(null, '/api/v1/auth/reset-password', { token, password: 'another-password-1' });
    expect(replay.status).toBe(422);
    expect((await loginReq(alice.email, 'another-password-1')).status).toBe(401);
    expect(JSON.stringify((await pool.query('SELECT * FROM audit_logs')).rows)).not.toContain(token);
  });

  it('expired, superseded or bogus tokens are rejected', async () => {
    await post(null, '/api/v1/auth/forgot-password', { email: alice.email });
    const first = await tokenFromOutbox(alice.email);
    await post(null, '/api/v1/auth/forgot-password', { email: alice.email });
    const second = await tokenFromOutbox(alice.email);
    expect(second).not.toBe(first);
    expect((await post(null, '/api/v1/auth/reset-password', { token: first, password: 'brand-new-password' })).status).toBe(422);

    await query(pool, `UPDATE email_tokens SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    expect((await post(null, '/api/v1/auth/reset-password', { token: second, password: 'brand-new-password' })).status).toBe(422);
    expect((await post(null, '/api/v1/auth/reset-password', { token: 'x'.repeat(43), password: 'brand-new-password' })).status).toBe(422);
    expect((await loginReq(alice.email, PASSWORD)).status).toBe(200);
  });

  it('a rejected weak password does not burn the token', async () => {
    await post(null, '/api/v1/auth/forgot-password', { email: alice.email });
    const token = await tokenFromOutbox(alice.email);
    expect((await post(null, '/api/v1/auth/reset-password', { token, password: 'short' })).status).toBe(422);
    expect((await post(null, '/api/v1/auth/reset-password', { token, password: 'long-enough-now' })).status).toBe(200);
  });
});

describe('password change', () => {
  it('requires the current password and revokes other sessions but keeps the current one', async () => {
    const current = await login(alice.email);
    const other = await login(alice.email);
    expect((await post(current, '/api/v1/me/password', { currentPassword: 'wrong-password', newPassword: 'changed-password-1' })).status).toBe(422);
    expect((await get(other, '/api/v1/me')).status).toBe(200);
    expect((await post(current, '/api/v1/me/password', { currentPassword: PASSWORD, newPassword: 'changed-password-1' })).status).toBe(200);
    expect((await get(current, '/api/v1/me')).status).toBe(200);
    expect((await get(other, '/api/v1/me')).status).toBe(401);
    expect((await loginReq(alice.email, 'changed-password-1')).status).toBe(200);
  });
});

describe('AC-011 Google OAuth callback state validation', () => {
  const CB = '/api/v1/auth/google/callback';

  function stateCookie(over: Record<string, unknown> = {}, sign = (p: string) => hmac(`oauth:${p}`)) {
    const payload = Buffer.from(
      JSON.stringify({ state: 'good-state', nonce: 'n', verifier: 'v'.repeat(64), mode: 'login', uid: null, returnTo: '/', exp: Date.now() + 600_000, ...over }),
    ).toString('base64url');
    return `tavern_oauth=${payload}.${sign(payload)}`;
  }

  async function expectRejected(url: string, cookie?: string) {
    const users = await count('SELECT count(*) FROM users');
    const res = await call('GET', url, { headers: cookie ? { cookie } : {} });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_ORIGIN}/login?error=google_failed`);
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/tavern_sid=[^;]/);
    expect(await count('SELECT count(*) FROM auth_identities')).toBe(0);
    expect(await count('SELECT count(*) FROM users')).toBe(users);
    expect(await count('SELECT count(*) FROM sessions')).toBe(0);
    return res;
  }

  it('rejects every state-validation failure before contacting Google', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expectRejected(`${CB}?state=good-state&code=abc`); // no state cookie
    await expectRejected(`${CB}?state=evil-state&code=abc`, stateCookie()); // mismatched state
    await expectRejected(`${CB}?code=abc`, stateCookie()); // state missing from query
    await expectRejected(`${CB}?state=good-state&code=abc`, stateCookie({}, () => 'forged-signature')); // tampered cookie
    await expectRejected(`${CB}?state=good-state&code=abc`, stateCookie({}, (p) => hmac(`other:${p}`))); // wrong key/purpose
    await expectRejected(`${CB}?state=good-state&code=abc`, stateCookie({ exp: Date.now() - 1000 })); // expired
    await expectRejected(`${CB}?state=good-state`, stateCookie()); // no code
    await expectRejected(`${CB}?state=good-state&code=abc`, 'tavern_oauth=garbage'); // malformed
    expect(fetchSpy).not.toHaveBeenCalled();
    const denied = (await pool.query(`SELECT outcome, metadata_json FROM audit_logs WHERE action = 'auth.google'`)).rows;
    expect(denied).toHaveLength(8);
    for (const r of denied) expect(r).toEqual({ outcome: 'denied', metadata_json: { reason: 'state_mismatch' } });
  });

  it('control: a valid state proceeds to the token exchange, whose failure still links nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expectRejected(`${CB}?state=good-state&code=abc`, stateCookie());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://oauth2.googleapis.com/token');
    expect(await one(pool, `SELECT metadata_json FROM audit_logs WHERE action = 'auth.google'`)).toEqual({ metadata_json: { reason: 'token_invalid' } });
  });

  it('the state cookie is cleared on every callback', async () => {
    const res = await call('GET', `${CB}?state=evil&code=abc`, { headers: { cookie: stateCookie() } });
    expect(String(res.headers['set-cookie'])).toMatch(/tavern_oauth=;/);
  });

  it('google start is refused while Google is not configured', async () => {
    const res = await call('GET', '/api/v1/auth/google/start');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_ORIGIN}/login?error=google_unavailable`);
    expect((await call('GET', '/api/v1/auth/providers')).body).toEqual({ google: false, password: true });
  });
});
