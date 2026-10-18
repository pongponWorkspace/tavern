import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool, query, tx } from '../db/pool.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { parse, uuid } from '../lib/validate.js';
import { slugify } from '../lib/text.js';
import { randomToken } from '../lib/crypto.js';
import { audit } from '../audit.js';
import { loadTenantAccess, requireTenant, requireUser } from '../authz/context.js';
import { canManageTenantMember, normalizeTenantPermissions, tenantCan, TENANT_CAPABILITIES, type TenantRole } from '../authz/policy.js';
import { diffMatrix } from '../lib/matrix.js';
import { visibleTo } from './knowledge-access.js';
import { itemSummary, ITEM_SUMMARY_COLUMNS } from './knowledge.js';

const tenantParams = z.object({ tenantId: uuid });

export async function tenantRoutes(app: FastifyInstance) {
  // ───────────── Tenants ─────────────

  app.post('/tenants', async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({ name: z.string().trim().min(2).max(80) }), req.body);
    const tenant = await tx(async (db) => {
      let slug = slugify(body.name);
      if (await one(db, 'SELECT 1 FROM tenants WHERE slug = $1', [slug])) slug = `${slug}-${randomToken(3).toLowerCase()}`;
      const t = await one(db, 'INSERT INTO tenants (name, slug, created_by) VALUES ($1,$2,$3) RETURNING id, name, slug', [body.name, slug, u.id]);
      await query(db, `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [t.id, u.id]);
      await audit(db, req, { tenantId: t.id, actorUserId: u.id, action: 'tenant.created', targetType: 'tenant', targetId: t.id, metadata: { name: body.name } });
      return t;
    });
    return reply.status(201).send({ ...tenant, role: 'owner' });
  });

  app.get('/tenants', async (req) => {
    const u = requireUser(req);
    const rows = await query(
      pool,
      `SELECT t.id, t.name, t.slug, tm.role FROM tenant_memberships tm JOIN tenants t ON t.id = tm.tenant_id
        WHERE tm.user_id = $1 AND tm.status = 'active' AND t.status = 'active' ORDER BY t.name`,
      [u.id],
    );
    return { data: rows };
  });

  app.get('/tenants/:tenantId', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(tenantParams, req.params);
    const access = await loadTenantAccess(pool, u.id, tenantId);
    const t = await one(pool, 'SELECT id, name, slug, created_at, project_invites_add_tenant_members FROM tenants WHERE id = $1', [tenantId]);
    const can = (a: Parameters<typeof tenantCan>[1]) => tenantCan(access.role, a, access.permissions);
    const viewSettings = can('tenant.view_settings');
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      createdAt: t.created_at,
      myRole: access.role,
      permissions: {
        manageSettings: viewSettings,
        editSettings: can('tenant.edit_settings'),
        manageMembers: can('tenant.manage_members'),
        createWorkspace: can('workspace.create'),
        editWorkspace: can('workspace.edit'),
        createProject: can('project.create'),
        listAllProjects: can('project.list_all'),
        viewAudit: can('tenant.view_audit'),
        transferOwnership: can('tenant.transfer_ownership'),
        manageRoles: can('tenant.manage_roles'),
      },
      // Everyone in the organization can see what each role may do (read-only unless Owner).
      rolePermissions: access.permissions,
      ...(viewSettings ? { settings: { projectInvitesAddTenantMembers: t.project_invites_add_tenant_members } } : {}),
    };
  });

  // Storage used by this organization's files (live, not-deleted objects), with a per-project breakdown.
  app.get('/tenants/:tenantId/storage', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(tenantParams, req.params);
    await requireTenant(pool, u.id, tenantId, 'tenant.view_settings');
    const rows = await query(
      pool,
      `SELECT p.id, p.name, count(f.id)::int AS files, coalesce(sum(f.size_bytes),0)::bigint AS used
         FROM projects p LEFT JOIN files f ON f.project_id = p.id AND f.deleted_at IS NULL
        WHERE p.tenant_id = $1 GROUP BY p.id, p.name HAVING count(f.id) > 0 ORDER BY used DESC LIMIT 20`,
      [tenantId],
    );
    const total = await one(pool, `SELECT count(*)::int AS files, coalesce(sum(size_bytes),0)::bigint AS used FROM files WHERE tenant_id = $1 AND deleted_at IS NULL`, [tenantId]);
    return {
      used: Number(total.used),
      files: total.files,
      limit: config.uploads.tenantQuotaBytes,
      byProject: rows.map((r) => ({ id: r.id, name: r.name, files: r.files, used: Number(r.used) })),
    };
  });

  // Organization RBAC table. Owner-only: changing it changes who controls the organization.
  app.put('/tenants/:tenantId/role-permissions', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(tenantParams, req.params);
    const caps = z.object(Object.fromEntries(TENANT_CAPABILITIES.map((c) => [c, z.boolean().optional()]))).strict();
    const body = parse(z.object({ permissions: z.object({ admin: caps.optional(), member: caps.optional() }).strict() }), req.body);
    const result = await tx(async (db) => {
      const access = await requireTenant(db, u.id, tenantId, 'tenant.manage_roles');
      await query(db, 'SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
      const before = access.permissions;
      const after = normalizeTenantPermissions({
        admin: { ...before.admin, ...body.permissions.admin },
        member: { ...before.member, ...body.permissions.member },
      });
      const changes = diffMatrix(before, after);
      if (changes.length === 0) return after;
      await query(db, 'UPDATE tenants SET role_permissions = $2, updated_at = now() WHERE id = $1', [tenantId, JSON.stringify(after)]);
      await audit(db, req, { tenantId, actorUserId: u.id, action: 'tenant.permissions_changed', targetType: 'tenant', targetId: tenantId, metadata: { changes } });
      return after;
    });
    return { rolePermissions: result };
  });

  app.patch('/tenants/:tenantId', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(tenantParams, req.params);
    const body = parse(
      z.object({ name: z.string().trim().min(2).max(80).optional(), projectInvitesAddTenantMembers: z.boolean().optional() }),
      req.body,
    );
    await tx(async (db) => {
      await requireTenant(db, u.id, tenantId, 'tenant.edit_settings');
      await query(
        db,
        `UPDATE tenants SET name = coalesce($2, name),
                project_invites_add_tenant_members = coalesce($3, project_invites_add_tenant_members), updated_at = now()
          WHERE id = $1`,
        [tenantId, body.name ?? null, body.projectInvitesAddTenantMembers ?? null],
      );
      await audit(db, req, { tenantId, actorUserId: u.id, action: 'tenant.settings_updated', targetType: 'tenant', targetId: tenantId, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });

  // ───────────── Tenant members ─────────────

  app.get('/tenants/:tenantId/members', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(tenantParams, req.params);
    await requireTenant(pool, u.id, tenantId, 'tenant.manage_members');
    const rows = await query(
      pool,
      `SELECT u.id, u.email, u.display_name, u.avatar_url, tm.role, tm.status, tm.joined_at,
              (SELECT count(*) FROM project_memberships pm WHERE pm.tenant_id = tm.tenant_id AND pm.user_id = u.id AND pm.status = 'active') AS project_count
         FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
        WHERE tm.tenant_id = $1
        ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name`,
      [tenantId],
    );
    return {
      data: rows.map((r) => ({
        userId: r.id, email: r.email, displayName: r.display_name, avatarUrl: r.avatar_url,
        role: r.role, status: r.status, joinedAt: r.joined_at, projectCount: r.project_count,
      })),
    };
  });

  app.patch('/tenants/:tenantId/members/:userId', async (req) => {
    const u = requireUser(req);
    const { tenantId, userId } = parse(z.object({ tenantId: uuid, userId: uuid }), req.params);
    const body = parse(
      z.object({ role: z.enum(['admin', 'member']).optional(), status: z.enum(['active', 'suspended']).optional() }),
      req.body,
    );
    await tx(async (db) => {
      const actor = await requireTenant(db, u.id, tenantId, 'tenant.manage_members');
      const target = await one(db, 'SELECT role, status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE', [tenantId, userId]);
      if (!target) throw notFound('member');
      if (userId === u.id) throw forbidden('You cannot change your own organization role.');
      if (!canManageTenantMember(actor.role, target.role as TenantRole, body.role, true)) throw forbidden();
      await query(
        db,
        `UPDATE tenant_memberships SET role = coalesce($3, role), status = coalesce($4, status), updated_at = now() WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId, body.role ?? null, body.status ?? null],
      );
      await audit(db, req, {
        tenantId, actorUserId: u.id, action: body.status && body.status !== target.status ? `tenant.member_${body.status === 'suspended' ? 'suspended' : 'reactivated'}` : 'tenant.member_role_changed',
        targetType: 'user', targetId: userId, metadata: { fromRole: target.role, toRole: body.role ?? target.role },
      });
    });
    return { ok: true };
  });

  app.delete('/tenants/:tenantId/members/:userId', async (req) => {
    const u = requireUser(req);
    const { tenantId, userId } = parse(z.object({ tenantId: uuid, userId: uuid }), req.params);
    await tx(async (db) => {
      const actor = await requireTenant(db, u.id, tenantId, 'tenant.manage_members');
      const target = await one(db, 'SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE', [tenantId, userId]);
      if (!target) throw notFound('member');
      if (target.role === 'owner') throw forbidden('Transfer ownership before removing the owner.');
      if (!canManageTenantMember(actor.role, target.role as TenantRole, undefined, true)) throw forbidden();
      // Don't orphan a project: each must keep at least one other active Project Admin (§11).
      const orphaned = await query(
        db,
        `SELECT p.name FROM project_memberships pm JOIN projects p ON p.id = pm.project_id
          WHERE pm.tenant_id = $1 AND pm.user_id = $2 AND pm.role = 'project_admin' AND pm.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM project_memberships o WHERE o.project_id = pm.project_id AND o.user_id <> $2
                              AND o.role = 'project_admin' AND o.status = 'active')`,
        [tenantId, userId],
      );
      if (orphaned.length) {
        throw conflict(`This person is the only Project Admin of: ${orphaned.map((o) => o.name).join(', ')}. Assign another admin first.`);
      }
      await query(db, 'DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]); // cascades project memberships
      await audit(db, req, { tenantId, actorUserId: u.id, action: 'tenant.member_removed', targetType: 'user', targetId: userId, metadata: { role: target.role } });
    });
    return { ok: true };
  });

  app.post('/tenants/:tenantId/transfer-ownership', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(tenantParams, req.params);
    const body = parse(z.object({ userId: uuid }), req.body);
    await tx(async (db) => {
      await requireTenant(db, u.id, tenantId, 'tenant.transfer_ownership');
      const target = await one(db, `SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`, [tenantId, body.userId]);
      if (!target || body.userId === u.id) throw notFound('member');
      await query(db, `UPDATE tenant_memberships SET role = 'admin', updated_at = now() WHERE tenant_id = $1 AND user_id = $2`, [tenantId, u.id]);
      await query(db, `UPDATE tenant_memberships SET role = 'owner', updated_at = now() WHERE tenant_id = $1 AND user_id = $2`, [tenantId, body.userId]);
      await audit(db, req, { tenantId, actorUserId: u.id, action: 'tenant.ownership_transferred', targetType: 'user', targetId: body.userId });
    });
    return { ok: true };
  });

  // ───────────── Workspaces ─────────────

  app.get('/tenants/:tenantId/workspaces', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(tenantParams, req.params);
    const access = await loadTenantAccess(pool, u.id, tenantId);
    const listAll = tenantCan(access.role, 'project.list_all', access.permissions);
    const rows = await query(
      pool,
      `SELECT w.id, w.name, w.slug, w.description, w.status, w.created_at,
              (SELECT count(*) FROM projects p WHERE p.workspace_id = w.id AND p.status = 'active'
                 AND ($2 OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = p.id AND pm.user_id = $3 AND pm.status = 'active'))) AS project_count
         FROM workspaces w WHERE w.tenant_id = $1
        ORDER BY w.status, w.name`,
      [tenantId, listAll, u.id],
    );
    return {
      data: rows.map((w) => ({ id: w.id, name: w.name, slug: w.slug, description: w.description, status: w.status, createdAt: w.created_at, projectCount: w.project_count })),
    };
  });

  app.post('/tenants/:tenantId/workspaces', async (req, reply) => {
    const u = requireUser(req);
    const { tenantId } = parse(tenantParams, req.params);
    const body = parse(z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(500).default('') }), req.body);
    const ws = await tx(async (db) => {
      await requireTenant(db, u.id, tenantId, 'workspace.create');
      let slug = slugify(body.name);
      if (await one(db, 'SELECT 1 FROM workspaces WHERE tenant_id = $1 AND slug = $2', [tenantId, slug])) slug = `${slug}-${randomToken(3).toLowerCase()}`;
      const w = await one(
        db,
        'INSERT INTO workspaces (tenant_id, name, slug, description, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, slug, description, status',
        [tenantId, body.name, slug, body.description, u.id],
      );
      await audit(db, req, { tenantId, actorUserId: u.id, action: 'workspace.created', targetType: 'workspace', targetId: w.id, metadata: { name: body.name } });
      return w;
    });
    return reply.status(201).send(ws);
  });

  app.patch('/workspaces/:workspaceId', async (req) => {
    const u = requireUser(req);
    const { workspaceId } = parse(z.object({ workspaceId: uuid }), req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80).optional(),
        description: z.string().trim().max(500).optional(),
        status: z.enum(['active', 'archived']).optional(),
      }),
      req.body,
    );
    await tx(async (db) => {
      const ws = await one(db, 'SELECT tenant_id, status FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
      if (!ws) throw notFound('workspace');
      try {
        await requireTenant(db, u.id, ws.tenant_id, 'workspace.edit');
      } catch (err: any) {
        throw err.status === 404 ? notFound('workspace') : err;
      }
      await query(
        db,
        `UPDATE workspaces SET name = coalesce($2, name), description = coalesce($3, description), status = coalesce($4, status), updated_at = now() WHERE id = $1`,
        [workspaceId, body.name ?? null, body.description ?? null, body.status ?? null],
      );
      await audit(db, req, {
        tenantId: ws.tenant_id, actorUserId: u.id,
        action: body.status && body.status !== ws.status ? `workspace.${body.status === 'archived' ? 'archived' : 'restored'}` : 'workspace.updated',
        targetType: 'workspace', targetId: workspaceId, metadata: { fields: Object.keys(body) },
      });
    });
    return { ok: true };
  });

  // ───────────── Dashboard & cross-project search ─────────────

  app.get('/tenants/:tenantId/dashboard', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(tenantParams, req.params);
    await loadTenantAccess(pool, u.id, tenantId);
    const projects = await query(
      pool,
      `SELECT p.id, p.name, p.description, p.status, p.updated_at, w.id AS workspace_id, w.name AS workspace_name, pm.role,
              (SELECT count(*) FROM knowledge_items ki WHERE ki.project_id = p.id AND ki.status = 'active' AND ${visibleTo('ki', 'pm.role')}) AS item_count,
              (SELECT max(ki.updated_at) FROM knowledge_items ki WHERE ki.project_id = p.id AND ki.status = 'active' AND ${visibleTo('ki', 'pm.role')}) AS last_activity_at
         FROM project_memberships pm
         JOIN projects p ON p.id = pm.project_id AND p.tenant_id = pm.tenant_id
         JOIN workspaces w ON w.id = p.workspace_id
        WHERE pm.tenant_id = $1 AND pm.user_id = $2 AND pm.status = 'active'
        ORDER BY p.status, greatest(p.updated_at, coalesce((SELECT max(ki.updated_at) FROM knowledge_items ki WHERE ki.project_id = p.id), p.updated_at)) DESC
        LIMIT 50`,
      [tenantId, u.id],
    );
    const recent = await query(
      pool,
      `SELECT ${ITEM_SUMMARY_COLUMNS}, p.name AS project_name
         FROM knowledge_items ki
         JOIN project_memberships pm ON pm.project_id = ki.project_id AND pm.user_id = $2 AND pm.status = 'active'
         JOIN projects p ON p.id = ki.project_id
         LEFT JOIN knowledge_categories c ON c.id = ki.category_id
         LEFT JOIN users ou ON ou.id = ki.owner_user_id
         LEFT JOIN files f ON f.id = ki.file_id
        WHERE ki.tenant_id = $1 AND ki.status = 'active' AND ${visibleTo('ki', 'pm.role')}
        ORDER BY ki.updated_at DESC, ki.id DESC LIMIT 8`,
      [tenantId, u.id],
    );
    const onboarding = await one(
      pool,
      `SELECT count(*) FILTER (WHERE s.is_required) AS required,
              count(*) FILTER (WHERE s.is_required AND op.status = 'completed') AS completed
         FROM project_memberships pm
         JOIN onboarding_templates t ON t.project_id = pm.project_id AND t.status = 'active' AND (t.target_role IS NULL OR t.target_role = pm.role)
         JOIN onboarding_steps s ON s.template_id = t.id
         LEFT JOIN onboarding_progress op ON op.step_id = s.id AND op.user_id = pm.user_id
        WHERE pm.tenant_id = $1 AND pm.user_id = $2 AND pm.status = 'active'`,
      [tenantId, u.id],
    );
    return {
      projects: projects.map((p) => ({
        id: p.id, name: p.name, description: p.description, status: p.status, role: p.role,
        workspace: { id: p.workspace_id, name: p.workspace_name }, itemCount: p.item_count, lastActivityAt: p.last_activity_at ?? p.updated_at,
      })),
      recentKnowledge: recent.map((r) => ({ ...itemSummary(r), project: { id: r.project_id, name: r.project_name } })),
      onboarding: { required: onboarding?.required ?? 0, completed: onboarding?.completed ?? 0 },
    };
  });

  app.get('/tenants/:tenantId/search', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(tenantParams, req.params);
    const q = parse(z.object({ q: z.string().trim().min(1).max(100), limit: z.coerce.number().int().min(1).max(50).default(20) }), req.query);
    await loadTenantAccess(pool, u.id, tenantId);
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await query(
      pool,
      `SELECT ${ITEM_SUMMARY_COLUMNS}, p.name AS project_name,
              ts_rank(ki.search_vector, plainto_tsquery('simple', $3)) AS rank
         FROM knowledge_items ki
         JOIN project_memberships pm ON pm.project_id = ki.project_id AND pm.user_id = $2 AND pm.status = 'active'
         JOIN projects p ON p.id = ki.project_id
         LEFT JOIN knowledge_categories c ON c.id = ki.category_id
         LEFT JOIN users ou ON ou.id = ki.owner_user_id
         LEFT JOIN files f ON f.id = ki.file_id
        WHERE ki.tenant_id = $1 AND ki.status = 'active' AND ${visibleTo('ki', 'pm.role')}
          AND (ki.search_vector @@ plainto_tsquery('simple', $3) OR ki.title ILIKE $4 OR ki.description ILIKE $4
               OR EXISTS (SELECT 1 FROM knowledge_item_tags it JOIN knowledge_tags tg ON tg.id = it.tag_id
                           WHERE it.knowledge_item_id = ki.id AND tg.name ILIKE $4))
        ORDER BY rank DESC, ki.updated_at DESC LIMIT $5`,
      [tenantId, u.id, q.q, like, q.limit],
    );
    return { data: rows.map((r) => ({ ...itemSummary(r), project: { id: r.project_id, name: r.project_name } })) };
  });
}
