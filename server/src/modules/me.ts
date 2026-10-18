import type { FastifyInstance } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import { one, pool, query, tx } from '../db/pool.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { parse, uuid } from '../lib/validate.js';
import { audit } from '../audit.js';
import { requireUser } from '../authz/context.js';
import { revokeAllSessions } from '../auth/session.js';

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => {
    const u = requireUser(req);
    const row = await one(
      pool,
      `SELECT u.id, u.email, u.display_name, u.avatar_url, u.email_verified_at, u.password_hash IS NOT NULL AS has_password,
              EXISTS (SELECT 1 FROM auth_identities a WHERE a.user_id = u.id AND a.provider = 'google') AS google_linked
         FROM users u WHERE u.id = $1`,
      [u.id],
    );
    const tenants = await query(
      pool,
      `SELECT t.id, t.name, t.slug, tm.role
         FROM tenant_memberships tm JOIN tenants t ON t.id = tm.tenant_id
        WHERE tm.user_id = $1 AND tm.status = 'active' AND t.status = 'active'
        ORDER BY t.name`,
      [u.id],
    );
    return {
      user: {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        emailVerified: Boolean(row.email_verified_at),
        hasPassword: row.has_password,
        googleLinked: row.google_linked,
      },
      csrfToken: req.csrfToken,
      tenants: tenants.map((t) => ({ id: t.id, name: t.name, slug: t.slug, role: t.role })),
    };
  });

  app.get('/me/tenants', async (req) => {
    const u = requireUser(req);
    const rows = await query(
      pool,
      `SELECT t.id, t.name, t.slug, tm.role FROM tenant_memberships tm JOIN tenants t ON t.id = tm.tenant_id
        WHERE tm.user_id = $1 AND tm.status = 'active' AND t.status = 'active' ORDER BY t.name`,
      [u.id],
    );
    return { data: rows };
  });

  app.patch('/me', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ displayName: z.string().trim().min(1).max(80) }), req.body);
    await query(pool, 'UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1', [u.id, body.displayName]);
    return { ok: true };
  });

  app.post('/me/password', async (req) => {
    const u = requireUser(req);
    const body = parse(
      z.object({ currentPassword: z.string().max(200).optional(), newPassword: z.string().min(10, 'must be at least 10 characters').max(200) }),
      req.body,
    );
    const row = await one(pool, 'SELECT password_hash FROM users WHERE id = $1', [u.id]);
    if (row.password_hash) {
      const ok = body.currentPassword ? await verify(row.password_hash, body.currentPassword).catch(() => false) : false;
      if (!ok) throw new AppError(422, 'VALIDATION_ERROR', 'currentPassword: your current password is incorrect');
    } else if (!u.emailVerified) {
      throw forbidden('Verify your email before adding a password.');
    }
    const newHash = await hash(body.newPassword);
    await tx(async (db) => {
      await query(db, 'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, newHash]);
      await revokeAllSessions(db, u.id, u.sessionId);
      await audit(db, req, { actorUserId: u.id, action: 'auth.password_changed', targetType: 'user', targetId: u.id });
    });
    return { ok: true };
  });

  app.get('/me/sessions', async (req) => {
    const u = requireUser(req);
    const rows = await query(
      pool,
      `SELECT id, user_agent, created_at, last_seen_at FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
      [u.id],
    );
    return {
      data: rows.map((s) => ({ id: s.id, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.id === u.sessionId })),
    };
  });

  app.delete('/me/sessions/:sessionId', async (req) => {
    const u = requireUser(req);
    const { sessionId } = parse(z.object({ sessionId: uuid }), req.params);
    const row = await one(pool, 'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id', [sessionId, u.id]);
    if (!row) throw notFound('session');
    return { ok: true };
  });

  app.post('/me/sessions/revoke-others', async (req) => {
    const u = requireUser(req);
    await revokeAllSessions(pool, u.id, u.sessionId);
    await audit(pool, req, { actorUserId: u.id, action: 'auth.sessions_revoked', targetType: 'user', targetId: u.id });
    return { ok: true };
  });
}
