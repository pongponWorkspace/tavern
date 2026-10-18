import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one, query, type Db } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { SessionUser } from '../authz/context.js';

const cookieOpts = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.isProd,
  path: '/',
  maxAge: config.session.ttlDays * 24 * 3600,
});

/** Create a fresh session (new identifier on every login — §12.1 rotation). */
export async function startSession(db: Db, reply: FastifyReply, req: FastifyRequest, userId: string) {
  const token = randomToken();
  const csrf = randomToken(24);
  await query(
    db,
    `INSERT INTO sessions (user_id, token_hash, csrf_token, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [userId, sha256(token), csrf, (req.headers['user-agent'] ?? '').slice(0, 200), config.session.ttlDays],
  );
  await query(db, 'UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  reply.setCookie(config.session.cookieName, token, cookieOpts());
  return { csrfToken: csrf };
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(config.session.cookieName, { path: '/' });
}

/** Resolve the session cookie to an active user, or null. */
export async function resolveSession(db: Db, token: string | undefined) {
  if (!token) return null;
  const row = await one(
    db,
    `SELECT s.id AS session_id, s.csrf_token, s.last_seen_at, u.id, u.email, u.display_name, u.email_verified_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [sha256(token)],
  );
  if (!row) return null;
  // Touch at most once a minute to avoid a write per request.
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    await query(db, 'UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  }
  const user: SessionUser = {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: Boolean(row.email_verified_at),
    sessionId: row.session_id,
  };
  return { user, csrfToken: row.csrf_token as string };
}

export async function revokeAllSessions(db: Db, userId: string, exceptSessionId?: string) {
  await query(
    db,
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
    [userId, exceptSessionId ?? null],
  );
}
