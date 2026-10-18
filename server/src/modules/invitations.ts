// Invitation links (FR-009). Tokens are 256-bit random, stored only as SHA-256
// hashes, shown to the inviter exactly once, and never logged or audited.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool, query, tx } from '../db/pool.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { appLink, sendMail } from '../lib/mail.js';
import { normalizeEmail } from '../lib/text.js';
import { parse, projectRole, uuid } from '../lib/validate.js';
import { audit } from '../audit.js';
import { loadProjectAccess, requireProject, requireTenant, requireUser } from '../authz/context.js';
import { canManageTenantMember, projectCan, tenantCan } from '../authz/policy.js';

const ROLE_LABEL: Record<string, string> = {
  project_admin: 'Project Admin', maintainer: 'Maintainer', member: 'Member', viewer: 'Viewer', admin: 'Organization Admin',
};

const optionsSchema = {
  expiresInDays: z.number().int().min(1).max(config.invitations.maxExpiryDays).default(config.invitations.defaultExpiryDays),
  maxUses: z.number().int().min(1).max(500).default(config.invitations.defaultMaxUses),
  email: z.string().trim().email().optional(),
  allowedDomain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'enter a domain like example.com').optional(),
};

/** Stored status, with "active but past expiry" reported as expired. */
const effectiveStatus = (r: any) => (r.status === 'active' && new Date(r.expires_at) <= new Date() ? 'expired' : r.status);

function present(r: any) {
  return {
    id: r.id,
    scope: r.project_id ? 'project' : 'tenant',
    projectId: r.project_id,
    role: r.target_role,
    email: r.email_restriction,
    allowedDomain: r.allowed_domain,
    maxUses: r.max_uses,
    useCount: r.use_count,
    expiresAt: r.expires_at,
    status: effectiveStatus(r),
    createdAt: r.created_at,
    createdBy: r.created_by_name ? { id: r.created_by, displayName: r.created_by_name } : undefined,
    revokedAt: r.revoked_at,
  };
}

async function createInvitation(
  req: FastifyRequest,
  scope: { tenantId: string; projectId: string | null; name: string },
  body: { role: string; expiresInDays: number; maxUses: number; email?: string; allowedDomain?: string },
  actorId: string,
) {
  const token = randomToken(32);
  const email = body.email ? normalizeEmail(body.email) : null;
  const maxUses = email ? 1 : body.maxUses; // an email-bound invite can only ever be used by one person
  const inv = await tx(async (db) => {
    const r = await one(
      db,
      `INSERT INTO invitations (tenant_id, project_id, token_hash, target_role, email_restriction, allowed_domain, max_uses, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(days => $8), $9) RETURNING *`,
      [scope.tenantId, scope.projectId, sha256(token), body.role, email, body.allowedDomain ?? null, maxUses, body.expiresInDays, actorId],
    );
    await audit(db, req, {
      tenantId: scope.tenantId, projectId: scope.projectId, actorUserId: actorId, action: 'invitation.created', targetType: 'invitation', targetId: r.id,
      metadata: { role: body.role, maxUses, expiresInDays: body.expiresInDays, emailRestricted: Boolean(email), domainRestricted: Boolean(body.allowedDomain) },
    });
    if (email) {
      await sendMail(db, email, `You're invited to ${scope.name} on Tavern`, `You've been invited to join ${scope.name} as ${ROLE_LABEL[body.role] ?? body.role}.\n\nAccept the invitation:\n${appLink(`/invite/${token}`)}\n\nThis link expires in ${body.expiresInDays} days.`);
    }
    return r;
  });
  return { invitation: present(inv), url: appLink(`/invite/${token}`) };
}

export async function invitationRoutes(app: FastifyInstance) {
  // ───────────── Create / list ─────────────

  app.post('/projects/:projectId/invitations', async (req, reply) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const body = parse(z.object({ role: projectRole, ...optionsSchema }), req.body);
    const access = await requireProject(pool, u.id, projectId, 'invitations.manage', { write: true });
    return reply.status(201).send(await createInvitation(req, { tenantId: access.tenantId, projectId, name: access.projectName }, body, u.id));
  });

  app.get('/projects/:projectId/invitations', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    await requireProject(pool, u.id, projectId, 'invitations.manage');
    const rows = await query(
      pool,
      `SELECT i.*, u.display_name AS created_by_name FROM invitations i JOIN users u ON u.id = i.created_by
        WHERE i.project_id = $1 ORDER BY i.created_at DESC LIMIT 100`,
      [projectId],
    );
    return { data: rows.map(present) };
  });

  app.post('/tenants/:tenantId/invitations', async (req, reply) => {
    const u = requireUser(req);
    const { tenantId } = parse(z.object({ tenantId: uuid }), req.params);
    const body = parse(z.object({ role: z.enum(['admin', 'member']).default('member'), ...optionsSchema }), req.body);
    const access = await requireTenant(pool, u.id, tenantId, 'tenant.manage_members');
    if (!canManageTenantMember(access.role, 'member', body.role, true)) throw forbidden('Only the organization owner can invite admins.');
    return reply.status(201).send(await createInvitation(req, { tenantId, projectId: null, name: access.tenantName }, body, u.id));
  });

  app.get('/tenants/:tenantId/invitations', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(z.object({ tenantId: uuid }), req.params);
    await requireTenant(pool, u.id, tenantId, 'tenant.manage_members');
    const rows = await query(
      pool,
      `SELECT i.*, u.display_name AS created_by_name FROM invitations i JOIN users u ON u.id = i.created_by
        WHERE i.tenant_id = $1 AND i.project_id IS NULL ORDER BY i.created_at DESC LIMIT 100`,
      [tenantId],
    );
    return { data: rows.map(present) };
  });

  app.post('/invitations/:invitationId/revoke', async (req) => {
    const u = requireUser(req);
    const { invitationId } = parse(z.object({ invitationId: uuid }), req.params);
    await tx(async (db) => {
      const inv = await one(db, 'SELECT * FROM invitations WHERE id = $1 FOR UPDATE', [invitationId]);
      if (!inv) throw notFound('invitation');
      const allowed = inv.project_id
        ? await loadProjectAccess(db, u.id, inv.project_id).then((a) => projectCan(a.role, 'invitations.manage', a.permissions), () => false)
        : await requireTenant(db, u.id, inv.tenant_id, 'tenant.manage_members').then((a) => tenantCan(a.role, 'tenant.manage_members', a.permissions), () => false);
      if (!allowed) throw notFound('invitation');
      if (inv.status !== 'active') return;
      await query(db, `UPDATE invitations SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1`, [invitationId, u.id]);
      await audit(db, req, { tenantId: inv.tenant_id, projectId: inv.project_id, actorUserId: u.id, action: 'invitation.revoked', targetType: 'invitation', targetId: invitationId });
    });
    return { ok: true };
  });

  // ───────────── Preview / accept ─────────────

  const INVALID = 'This invitation link is no longer valid. Ask the person who invited you for a new one.';

  // Shows the invitee what they're joining; works before sign-in so the sign-up page has context.
  app.get('/invitations/preview', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const q = parse(z.object({ token: z.string().min(20).max(100) }), req.query);
    const inv = await one(
      pool,
      `SELECT i.*, t.name AS tenant_name, t.status AS tenant_status, p.name AS project_name, p.status AS project_status, u.display_name AS inviter_name
         FROM invitations i JOIN tenants t ON t.id = i.tenant_id JOIN users u ON u.id = i.created_by
         LEFT JOIN projects p ON p.id = i.project_id
        WHERE i.token_hash = $1`,
      [sha256(q.token)],
    );
    const valid = inv && effectiveStatus(inv) === 'active' && inv.tenant_status === 'active' && (!inv.project_id || inv.project_status === 'active');
    if (!valid) return { valid: false, message: INVALID };
    return {
      valid: true,
      tenantName: inv.tenant_name,
      projectName: inv.project_name,
      role: inv.target_role,
      roleLabel: ROLE_LABEL[inv.target_role] ?? inv.target_role,
      invitedBy: inv.inviter_name,
      expiresAt: inv.expires_at,
      emailRestricted: Boolean(inv.email_restriction),
    };
  });

  app.post('/invitations/accept', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ token: z.string().min(20).max(100) }), req.body);
    const fail = (msg = INVALID) => new AppError(410, 'INVITATION_INVALID', msg);

    const result = await tx(async (db) => {
      // Row lock serializes concurrent acceptances so use_count can't exceed max_uses (AC-007).
      const inv = await one(db, `SELECT * FROM invitations WHERE token_hash = $1 FOR UPDATE`, [sha256(body.token)]);
      if (!inv) throw fail();
      const target = { tenantId: inv.tenant_id as string, projectId: inv.project_id as string | null };

      // Idempotent for a user who already accepted this same invitation (§11).
      if (await one(db, 'SELECT 1 FROM invitation_acceptances WHERE invitation_id = $1 AND user_id = $2', [inv.id, u.id])) {
        return { ...target, alreadyMember: true };
      }
      if (inv.status === 'active' && new Date(inv.expires_at) <= new Date()) {
        await query(db, `UPDATE invitations SET status = 'expired' WHERE id = $1`, [inv.id]);
        await audit(db, req, { tenantId: inv.tenant_id, projectId: inv.project_id, actorUserId: u.id, action: 'invitation.accept', targetType: 'invitation', targetId: inv.id, outcome: 'denied', metadata: { reason: 'expired' } });
        return { error: 'expired' as const };
      }
      if (inv.status !== 'active') {
        await audit(db, req, { tenantId: inv.tenant_id, projectId: inv.project_id, actorUserId: u.id, action: 'invitation.accept', targetType: 'invitation', targetId: inv.id, outcome: 'denied', metadata: { reason: inv.status } });
        return { error: inv.status as string };
      }

      const tenant = await one(db, `SELECT status, project_invites_add_tenant_members FROM tenants WHERE id = $1`, [inv.tenant_id]);
      if (tenant?.status !== 'active') throw fail();
      if (inv.project_id) {
        const p = await one(db, `SELECT p.status, w.status AS ws_status FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = $1`, [inv.project_id]);
        if (p?.status !== 'active' || p.ws_status !== 'active') throw fail('This project is archived, so the invitation can no longer be used. Ask for a new one.');
      }

      // Email / domain restrictions require a verified address.
      if (inv.email_restriction || inv.allowed_domain) {
        if (!u.emailVerified) throw new AppError(403, 'FORBIDDEN', 'Verify your email address first — this invitation is restricted to a specific email.');
        if (inv.email_restriction && normalizeEmail(u.email) !== inv.email_restriction) {
          throw new AppError(403, 'FORBIDDEN', `This invitation was sent to a different email address. Sign in with that account to accept it.`);
        }
        if (inv.allowed_domain && normalizeEmail(u.email).split('@')[1] !== inv.allowed_domain) {
          throw new AppError(403, 'FORBIDDEN', `This invitation is limited to @${inv.allowed_domain} addresses.`);
        }
      }

      // Tenant membership.
      const tm = await one(db, `SELECT role, status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`, [inv.tenant_id, u.id]);
      if (tm?.status === 'suspended') throw fail('Your access to this organization is suspended.');
      let alreadyMember = false;
      if (!inv.project_id) {
        if (tm) alreadyMember = true;
        else await query(db, `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [inv.tenant_id, u.id, inv.target_role]);
      } else {
        if (!tm) {
          if (!tenant.project_invites_add_tenant_members) throw fail('This organization only lets existing members join projects. Ask an organization admin to invite you first.');
          await query(db, `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'member')`, [inv.tenant_id, u.id]);
        }
        const pm = await one(db, `SELECT status FROM project_memberships WHERE project_id = $1 AND user_id = $2 FOR UPDATE`, [inv.project_id, u.id]);
        if (pm?.status === 'active') alreadyMember = true; // never duplicate or silently change an existing membership
        else {
          await query(
            db,
            `INSERT INTO project_memberships (tenant_id, project_id, user_id, role, invited_by) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', invited_by = excluded.invited_by, joined_at = now(), updated_at = now()`,
            [inv.tenant_id, inv.project_id, u.id, inv.target_role, inv.created_by],
          );
        }
      }
      if (alreadyMember) return { ...target, alreadyMember: true };

      const updated = await one(
        db,
        `UPDATE invitations SET use_count = use_count + 1,
                status = CASE WHEN use_count + 1 >= max_uses THEN (CASE WHEN max_uses = 1 THEN 'accepted' ELSE 'exhausted' END) ELSE status END
          WHERE id = $1 AND status = 'active' AND use_count < max_uses RETURNING id`,
        [inv.id],
      );
      if (!updated) throw fail();
      await query(db, 'INSERT INTO invitation_acceptances (invitation_id, user_id) VALUES ($1,$2)', [inv.id, u.id]);
      await audit(db, req, {
        tenantId: inv.tenant_id, projectId: inv.project_id, actorUserId: u.id, action: 'invitation.accepted', targetType: 'invitation', targetId: inv.id,
        metadata: { role: inv.target_role },
      });
      await audit(db, req, {
        tenantId: inv.tenant_id, projectId: inv.project_id, actorUserId: u.id, action: inv.project_id ? 'project.member_added' : 'tenant.member_added',
        targetType: 'user', targetId: u.id, metadata: { role: inv.target_role, via: 'invitation' },
      });
      return { ...target, alreadyMember: false };
    });

    if ('error' in result) {
      throw fail(result.error === 'expired' ? 'This invitation has expired. Ask the person who invited you for a new link.'
        : result.error === 'revoked' ? 'This invitation was revoked. Ask the person who invited you for a new link.'
        : INVALID);
    }
    return { ok: true, tenantId: result.tenantId, projectId: result.projectId, alreadyMember: result.alreadyMember };
  });
}
