import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, pool, query, tx, type Db } from '../db/pool.js';
import { conflict, notFound } from '../lib/errors.js';
import { parse, projectRole, uuid } from '../lib/validate.js';
import { normalizeEmail } from '../lib/text.js';
import { audit } from '../audit.js';
import { requireProject, requireUser } from '../authz/context.js';

/** Reject changes that would leave a project without an active Project Admin (§11). */
async function assertNotLastAdmin(db: Db, projectId: string, userId: string) {
  const others = await one(
    db,
    `SELECT count(*)::int AS n FROM project_memberships WHERE project_id = $1 AND user_id <> $2 AND role = 'project_admin' AND status = 'active'`,
    [projectId, userId],
  );
  if (!others || others.n === 0) throw conflict('A project needs at least one Project Admin. Make someone else an admin first.');
}

export async function memberRoutes(app: FastifyInstance) {
  // Names and roles of teammates — visible to every member (owner pickers, "updated by").
  app.get('/projects/:projectId/people', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    await requireProject(pool, u.id, projectId, 'members.view_people');
    const rows = await query(
      pool,
      `SELECT u.id, u.display_name, u.avatar_url, pm.role FROM project_memberships pm JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = $1 AND pm.status = 'active' ORDER BY u.display_name`,
      [projectId],
    );
    return { data: rows.map((r) => ({ id: r.id, displayName: r.display_name, avatarUrl: r.avatar_url, role: r.role })) };
  });

  app.get('/projects/:projectId/members', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    await requireProject(pool, u.id, projectId, 'members.manage');
    const rows = await query(
      pool,
      `SELECT u.id, u.email, u.display_name, u.avatar_url, pm.role, pm.status, pm.joined_at, inv.display_name AS invited_by_name
         FROM project_memberships pm JOIN users u ON u.id = pm.user_id
         LEFT JOIN users inv ON inv.id = pm.invited_by
        WHERE pm.project_id = $1 AND pm.status = 'active'
        ORDER BY CASE pm.role WHEN 'project_admin' THEN 0 WHEN 'maintainer' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.display_name`,
      [projectId],
    );
    return {
      data: rows.map((r) => ({
        userId: r.id, email: r.email, displayName: r.display_name, avatarUrl: r.avatar_url, role: r.role,
        status: r.status, joinedAt: r.joined_at, invitedBy: r.invited_by_name,
      })),
    };
  });

  // Organization members who could be added: active in the tenant, not active in this project.
  app.get('/projects/:projectId/member-candidates', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const q = parse(z.object({ q: z.string().trim().max(100).default(''), limit: z.coerce.number().int().min(1).max(50).default(20) }), req.query);
    const access = await requireProject(pool, u.id, projectId, 'members.manage');
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await query(
      pool,
      `SELECT u.id, u.display_name, u.email, u.avatar_url, tm.role AS tenant_role
         FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
        WHERE tm.tenant_id = $1 AND tm.status = 'active' AND u.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = $2 AND pm.user_id = u.id AND pm.status = 'active')
          AND ($3 = '' OR u.display_name ILIKE $4 OR u.email ILIKE $4)
        ORDER BY u.display_name LIMIT $5`,
      [access.tenantId, projectId, q.q, like, q.limit],
    );
    return {
      data: rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email, avatarUrl: r.avatar_url, tenantRole: r.tenant_role })),
    };
  });

  // Add people who already belong to the organization (no invitation needed).
  // Accepts picked user ids, or a single email.
  app.post('/projects/:projectId/members', async (req, reply) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const body = parse(
      z
        .object({ userIds: z.array(uuid).min(1).max(50).optional(), email: z.string().trim().email().optional(), role: projectRole })
        .refine((b) => Boolean(b.userIds) !== Boolean(b.email), { message: 'choose people to add', path: ['userIds'] }),
      req.body,
    );
    const added = await tx(async (db) => {
      const access = await requireProject(db, u.id, projectId, 'members.manage', { write: true });
      // Only active members of this same organization can be added — ids from elsewhere are rejected.
      const targets = await query<{ id: string }>(
        db,
        `SELECT u.id FROM users u JOIN tenant_memberships tm ON tm.user_id = u.id AND tm.tenant_id = $1 AND tm.status = 'active'
          WHERE u.status = 'active' AND ${body.userIds ? 'u.id = ANY($2::uuid[])' : 'lower(u.email) = $2'}`,
        [access.tenantId, body.userIds ? [...new Set(body.userIds)] : normalizeEmail(body.email!)],
      );
      if (body.email && targets.length === 0) throw notFound('organization member with that email — send them an invitation link instead');
      if (body.userIds && targets.length !== new Set(body.userIds).size) throw notFound('organization member');
      const ids = targets.map((t) => t.id);
      const already = await query<{ user_id: string }>(
        db,
        `SELECT user_id FROM project_memberships WHERE project_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'active' FOR UPDATE`,
        [projectId, ids],
      );
      if (already.length) throw conflict(already.length === 1 ? 'This person is already a member of the project.' : 'Some of these people are already members of the project.');
      for (const id of ids) {
        await query(
          db,
          `INSERT INTO project_memberships (tenant_id, project_id, user_id, role, invited_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', invited_by = excluded.invited_by, joined_at = now(), updated_at = now()`,
          [access.tenantId, projectId, id, body.role, u.id],
        );
        await audit(db, req, { tenantId: access.tenantId, projectId, actorUserId: u.id, action: 'project.member_added', targetType: 'user', targetId: id, metadata: { role: body.role } });
      }
      return ids.length;
    });
    return reply.status(201).send({ ok: true, added });
  });

  app.patch('/projects/:projectId/members/:userId', async (req) => {
    const u = requireUser(req);
    const { projectId, userId } = parse(z.object({ projectId: uuid, userId: uuid }), req.params);
    const body = parse(z.object({ role: projectRole }), req.body);
    await tx(async (db) => {
      const access = await requireProject(db, u.id, projectId, 'members.manage', { write: true });
      // Lock all admin rows so two concurrent demotions can't both pass the last-admin check.
      await query(db, `SELECT 1 FROM project_memberships WHERE project_id = $1 AND role = 'project_admin' FOR UPDATE`, [projectId]);
      const target = await one(db, `SELECT role FROM project_memberships WHERE project_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`, [projectId, userId]);
      if (!target) throw notFound('member');
      if (target.role === body.role) return;
      if (target.role === 'project_admin') await assertNotLastAdmin(db, projectId, userId);
      await query(db, `UPDATE project_memberships SET role = $3, updated_at = now() WHERE project_id = $1 AND user_id = $2`, [projectId, userId, body.role]);
      await audit(db, req, {
        tenantId: access.tenantId, projectId, actorUserId: u.id, action: 'project.member_role_changed', targetType: 'user', targetId: userId,
        metadata: { fromRole: target.role, toRole: body.role },
      });
    });
    return { ok: true };
  });

  app.delete('/projects/:projectId/members/:userId', async (req) => {
    const u = requireUser(req);
    const { projectId, userId } = parse(z.object({ projectId: uuid, userId: uuid }), req.params);
    await tx(async (db) => {
      const access = await requireProject(db, u.id, projectId, 'members.manage', { write: true });
      await query(db, `SELECT 1 FROM project_memberships WHERE project_id = $1 AND role = 'project_admin' FOR UPDATE`, [projectId]);
      const target = await one(db, `SELECT role FROM project_memberships WHERE project_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`, [projectId, userId]);
      if (!target) throw notFound('member');
      if (target.role === 'project_admin') await assertNotLastAdmin(db, projectId, userId);
      // Access checks read this row on every request, so revocation is immediate (AC-008).
      await query(db, `UPDATE project_memberships SET status = 'removed', updated_at = now() WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
      await audit(db, req, { tenantId: access.tenantId, projectId, actorUserId: u.id, action: 'project.member_removed', targetType: 'user', targetId: userId, metadata: { role: target.role } });
    });
    return { ok: true };
  });
}
