import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool, query, tx, type Db } from '../db/pool.js';
import { AppError, invalid } from '../lib/errors.js';
import { hmac, randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { appLink, sendMail } from '../lib/mail.js';
import { normalizeEmail } from '../lib/text.js';
import { parse } from '../lib/validate.js';
import { audit } from '../audit.js';
import { requireUser } from '../authz/context.js';
import { clearSessionCookie, revokeAllSessions, startSession } from './session.js';

const password = z.string().min(10, 'must be at least 10 characters').max(200);
const email = z.string().trim().email().max(254);

const rl = (max: number, timeWindow = '1 minute') => ({ config: { rateLimit: { max, timeWindow } } });

// A precomputed hash so failed logins for unknown emails cost the same as real ones.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hash(randomToken()));

async function issueEmailToken(db: Db, userId: string, purpose: 'verify_email' | 'reset_password', minutes: number) {
  const token = randomToken();
  await query(db, `UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await query(
    db,
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`,
    [userId, purpose, sha256(token), minutes],
  );
  return token;
}

/** Consume a single-use token atomically; returns the user id or null. */
async function consumeEmailToken(db: Db, token: string, purpose: string): Promise<string | null> {
  const row = await one<{ user_id: string }>(
    db,
    `UPDATE email_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sha256(token), purpose],
  );
  return row?.user_id ?? null;
}

async function sendVerification(db: Db, userId: string, to: string) {
  const token = await issueEmailToken(db, userId, 'verify_email', config.tokens.verifyEmailHours * 60);
  await sendMail(db, to, 'Verify your email for Tavern', `Confirm your email address:\n\n${appLink(`/verify-email?token=${token}`)}\n\nThis link expires in ${config.tokens.verifyEmailHours} hours.`);
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/auth/providers', async () => ({ google: config.google.enabled, password: true }));

  app.post('/auth/register', rl(5), async (req, reply) => {
    const body = parse(
      z.object({ email, password, displayName: z.string().trim().min(1).max(80) }),
      req.body,
    );
    const normalized = normalizeEmail(body.email);
    const passwordHash = await hash(body.password);
    const result = await tx(async (db) => {
      const existing = await one(db, 'SELECT id FROM users WHERE lower(email) = $1', [normalized]);
      if (existing) throw new AppError(409, 'CONFLICT', 'An account with this email already exists. Sign in instead, or reset your password.');
      const user = await one<{ id: string }>(
        db,
        `INSERT INTO users (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id`,
        [normalized, body.displayName, passwordHash],
      );
      await sendVerification(db, user!.id, normalized);
      const session = await startSession(db, reply, req, user!.id);
      await audit(db, req, { actorUserId: user!.id, action: 'auth.register', targetType: 'user', targetId: user!.id });
      return session;
    });
    return reply.status(201).send({ ok: true, csrfToken: result.csrfToken });
  });

  app.post('/auth/login', rl(10), async (req, reply) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
    const user = await one(
      pool,
      `SELECT id, password_hash, status FROM users WHERE lower(email) = $1`,
      [normalizeEmail(body.email)],
    );
    const ok = user?.password_hash
      ? await verify(user.password_hash, body.password).catch(() => false)
      : (await verify(await getDummyHash(), body.password).catch(() => false), false);
    if (!user || !ok || user.status !== 'active') {
      await audit(pool, req, { actorUserId: user?.id ?? null, action: 'auth.login', targetType: 'user', targetId: user?.id ?? null, outcome: 'denied' });
      throw new AppError(401, 'UNAUTHENTICATED', 'Email or password is incorrect.');
    }
    const session = await startSession(pool, reply, req, user.id);
    await audit(pool, req, { actorUserId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id });
    return { ok: true, csrfToken: session.csrfToken };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.user) await query(pool, 'UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.user.sessionId]);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post('/auth/forgot-password', rl(5), async (req) => {
    const body = parse(z.object({ email }), req.body);
    const user = await one(pool, `SELECT id, email FROM users WHERE lower(email) = $1 AND status = 'active'`, [normalizeEmail(body.email)]);
    if (user) {
      await tx(async (db) => {
        const token = await issueEmailToken(db, user.id, 'reset_password', config.tokens.resetPasswordMinutes);
        await sendMail(db, user.email, 'Reset your Tavern password', `Someone asked to reset your password. If it was you, choose a new one here:\n\n${appLink(`/reset-password?token=${token}`)}\n\nThis link expires in ${config.tokens.resetPasswordMinutes} minutes and can be used once. If it wasn't you, ignore this email.`);
      });
    }
    // Same response whether or not the email exists (§12.1 — no enumeration).
    return { ok: true, message: 'If an account exists for that email, a reset link is on its way.' };
  });

  app.post('/auth/reset-password', rl(10), async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password }), req.body);
    const passwordHash = await hash(body.password);
    await tx(async (db) => {
      const userId = await consumeEmailToken(db, body.token, 'reset_password');
      if (!userId) throw invalid('This reset link is invalid or has expired. Request a new one.');
      await query(
        db,
        `UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = $1`,
        [userId, passwordHash],
      );
      await revokeAllSessions(db, userId);
      await audit(db, req, { actorUserId: userId, action: 'auth.password_reset', targetType: 'user', targetId: userId });
    });
    return { ok: true };
  });

  app.post('/auth/verify-email', rl(20), async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    await tx(async (db) => {
      const userId = await consumeEmailToken(db, body.token, 'verify_email');
      if (!userId) throw invalid('This verification link is invalid or has expired.');
      await query(db, `UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [userId]);
      await audit(db, req, { actorUserId: userId, action: 'auth.email_verified', targetType: 'user', targetId: userId });
    });
    return { ok: true };
  });

  app.post('/auth/resend-verification', rl(3), async (req) => {
    const user = requireUser(req);
    if (user.emailVerified) return { ok: true };
    await tx((db) => sendVerification(db, user.id, user.email));
    return { ok: true };
  });

  // ───────────────────────── Google OAuth (Authorization Code + PKCE) ─────────────────────────

  const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
  const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
  const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  const OAUTH_COOKIE = 'tavern_oauth';
  const redirectUri = () => `${config.appOrigin}/api/v1/auth/google/callback`;

  const safeReturnTo = (v: unknown) =>
    typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v.slice(0, 300) : '/';

  const failRedirect = (reply: FastifyReply, reason: string) =>
    reply.redirect(`${config.appOrigin}/login?error=${encodeURIComponent(reason)}`);

  app.get('/auth/google/start', rl(20), async (req, reply) => {
    if (!config.google.enabled) return failRedirect(reply, 'google_unavailable');
    const q = req.query as Record<string, string>;
    const mode = q.mode === 'link' ? 'link' : 'login';
    if (mode === 'link' && !req.user) return failRedirect(reply, 'signin_required');

    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const payload = Buffer.from(
      JSON.stringify({ state, nonce, verifier, mode, uid: req.user?.id ?? null, returnTo: safeReturnTo(q.returnTo), exp: Date.now() + 600_000 }),
    ).toString('base64url');
    reply.setCookie(OAUTH_COOKIE, `${payload}.${hmac(`oauth:${payload}`)}`, {
      httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/api/v1/auth/google', maxAge: 600,
    });
    const url = new URL(GOOGLE_AUTH);
    url.search = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get('/auth/google/callback', rl(20), async (req: FastifyRequest, reply) => {
    const q = req.query as Record<string, string>;
    const raw = req.cookies[OAUTH_COOKIE];
    reply.clearCookie(OAUTH_COOKIE, { path: '/api/v1/auth/google' });

    // 1. Validate the signed state cookie and the returned state (AC-011).
    let saved: any = null;
    if (raw) {
      const [payload, sig] = raw.split('.');
      if (payload && sig && safeEqual(sig, hmac(`oauth:${payload}`))) {
        try { saved = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { saved = null; }
      }
    }
    if (!saved || saved.exp < Date.now() || typeof q.state !== 'string' || !safeEqual(q.state, saved.state) || !q.code) {
      await audit(pool, req, { action: 'auth.google', targetType: 'user', outcome: 'denied', metadata: { reason: 'state_mismatch' } });
      return failRedirect(reply, 'google_failed');
    }

    // 2. Exchange the code (with the PKCE verifier) and verify the ID token.
    let claims: { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
    try {
      const res = await fetch(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: q.code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirectUri(),
          grant_type: 'authorization_code',
          code_verifier: saved.verifier,
        }),
      });
      if (!res.ok) throw new Error(`token endpoint ${res.status}`);
      const tokens = (await res.json()) as { id_token?: string };
      if (!tokens.id_token) throw new Error('no id_token');
      const { payload } = await jwtVerify(tokens.id_token, googleJwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: config.google.clientId,
      });
      if (payload.nonce !== saved.nonce) throw new Error('nonce mismatch');
      claims = payload as typeof claims;
    } catch (err) {
      req.log.warn({ reason: (err as Error).message }, 'google oauth rejected');
      await audit(pool, req, { action: 'auth.google', targetType: 'user', outcome: 'denied', metadata: { reason: 'token_invalid' } });
      return failRedirect(reply, 'google_failed');
    }

    // 3. Resolve the identity to an account without unsafe merging (FR-001, §11).
    const outcome = await tx(async (db) => {
      const identity = await one(db, `SELECT user_id FROM auth_identities WHERE provider = 'google' AND provider_subject = $1`, [claims.sub]);

      if (saved.mode === 'link') {
        if (!saved.uid) return { error: 'signin_required' };
        if (identity && identity.user_id !== saved.uid) return { error: 'google_in_use' };
        if (!identity) {
          await query(db, `INSERT INTO auth_identities (user_id, provider, provider_subject, provider_email, last_used_at) VALUES ($1,'google',$2,$3, now())`, [saved.uid, claims.sub, claims.email ?? null]);
          await audit(db, req, { actorUserId: saved.uid, action: 'auth.google_linked', targetType: 'user', targetId: saved.uid });
        }
        return { linked: true };
      }

      if (identity) {
        const user = await one(db, `SELECT id, status FROM users WHERE id = $1`, [identity.user_id]);
        if (user?.status !== 'active') return { error: 'account_unavailable' };
        await query(db, `UPDATE auth_identities SET last_used_at = now() WHERE provider = 'google' AND provider_subject = $1`, [claims.sub]);
        return { userId: user.id as string };
      }

      if (!claims.email || claims.email_verified !== true) return { error: 'google_email_unverified' };
      const emailNorm = normalizeEmail(claims.email);
      const existing = await one(db, `SELECT id, status, email_verified_at FROM users WHERE lower(email) = $1`, [emailNorm]);
      if (existing) {
        // Auto-link only when both sides have proven ownership of the address;
        // otherwise someone could pre-register a victim's email with a password.
        if (!existing.email_verified_at || existing.status !== 'active') return { error: 'link_required' };
        await query(db, `INSERT INTO auth_identities (user_id, provider, provider_subject, provider_email, last_used_at) VALUES ($1,'google',$2,$3, now())`, [existing.id, claims.sub, emailNorm]);
        await audit(db, req, { actorUserId: existing.id, action: 'auth.google_linked', targetType: 'user', targetId: existing.id });
        return { userId: existing.id as string };
      }

      const created = await one<{ id: string }>(
        db,
        `INSERT INTO users (email, display_name, avatar_url, email_verified_at) VALUES ($1,$2,$3, now()) RETURNING id`,
        [emailNorm, (claims.name ?? emailNorm.split('@')[0]).slice(0, 80), claims.picture ?? null],
      );
      await query(db, `INSERT INTO auth_identities (user_id, provider, provider_subject, provider_email, last_used_at) VALUES ($1,'google',$2,$3, now())`, [created!.id, claims.sub, emailNorm]);
      await audit(db, req, { actorUserId: created!.id, action: 'auth.register', targetType: 'user', targetId: created!.id, metadata: { provider: 'google' } });
      return { userId: created!.id };
    });

    if ('error' in outcome) return failRedirect(reply, outcome.error!);
    if ('linked' in outcome) return reply.redirect(`${config.appOrigin}/account?linked=google`);
    await startSession(pool, reply, req, outcome.userId);
    await audit(pool, req, { actorUserId: outcome.userId, action: 'auth.login', targetType: 'user', targetId: outcome.userId, metadata: { provider: 'google' } });
    return reply.redirect(`${config.appOrigin}${saved.returnTo}`);
  });
}
