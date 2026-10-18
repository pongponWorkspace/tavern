import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, pool, query, tx } from '../db/pool.js';
import { conflict, notFound, readOnly } from '../lib/errors.js';
import { parse, uuid } from '../lib/validate.js';
import { slugify } from '../lib/text.js';
import { randomToken } from '../lib/crypto.js';
import { audit } from '../audit.js';
import { loadProjectAccess, loadTenantAccess, requireProject, requireTenant, requireUser } from '../authz/context.js';
import { normalizeProjectPermissions, projectCan, tenantCan, type ProjectAction } from '../authz/policy.js';
import { diffMatrix } from '../lib/matrix.js';
import { visibleTo } from './knowledge-access.js';
import { ITEM_SUMMARY_COLUMNS, itemSummary } from './knowledge.js';

const PERMISSION_KEYS: ProjectAction[] = [
  'project.edit', 'project.archive', 'knowledge.create', 'knowledge.view_archived', 'knowledge.restrict', 'category.manage',
  'members.manage', 'invitations.manage', 'audit.view', 'onboarding.manage', 'project.manage_roles',
];

export async function projectRoutes(app: FastifyInstance) {
  app.get('/workspaces/:workspaceId/projects', async (req) => {
    const u = requireUser(req);
    const { workspaceId } = parse(z.object({ workspaceId: uuid }), req.params);
    const ws = await one(pool, 'SELECT id, tenant_id, name, status, description FROM workspaces WHERE id = $1', [workspaceId]);
    if (!ws) throw notFound('workspace');
    const access = await loadTenantAccess(pool, u.id, ws.tenant_id).catch(() => {
      throw notFound('workspace');
    });
    // Tenant admins see every project's name/status (tenant-level metadata) but
    // still need a project membership to open its content.
    const listAll = tenantCan(access.role, 'project.list_all', access.permissions);
    const rows = await query(
      pool,
      `SELECT p.id, p.name, p.slug, p.description, p.status, p.updated_at, pm.role,
              (SELECT count(*) FROM project_memberships m WHERE m.project_id = p.id AND m.status = 'active') AS member_count
         FROM projects p
         LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $2 AND pm.status = 'active'
        WHERE p.workspace_id = $1 AND p.tenant_id = $3 AND ($4 OR pm.id IS NOT NULL)
        ORDER BY p.status, p.name`,
      [workspaceId, u.id, ws.tenant_id, listAll],
    );
    return {
      workspace: { id: ws.id, name: ws.name, status: ws.status, description: ws.description },
      data: rows.map((p) => ({
        id: p.id, name: p.name, slug: p.slug, description: p.description, status: p.status, updatedAt: p.updated_at,
        myRole: p.role ?? null, memberCount: listAll || p.role ? p.member_count : undefined,
      })),
    };
  });

  app.post('/workspaces/:workspaceId/projects', async (req, reply) => {
    const u = requireUser(req);
    const { workspaceId } = parse(z.object({ workspaceId: uuid }), req.params);
    const body = parse(
      z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(1000).default(''), contact: z.string().trim().max(200).default('') }),
      req.body,
    );
    const project = await tx(async (db) => {
      const ws = await one(db, 'SELECT tenant_id, status FROM workspaces WHERE id = $1', [workspaceId]);
      if (!ws) throw notFound('workspace');
      await requireTenant(db, u.id, ws.tenant_id, 'project.create').catch((e) => {
        throw e.status === 404 ? notFound('workspace') : e;
      });
      if (ws.status !== 'active') throw readOnly();
      let slug = slugify(body.name);
      if (await one(db, 'SELECT 1 FROM projects WHERE workspace_id = $1 AND slug = $2', [workspaceId, slug])) slug = `${slug}-${randomToken(3).toLowerCase()}`;
      const p = await one(
        db,
        `INSERT INTO projects (tenant_id, workspace_id, name, slug, description, contact, owner_user_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id, name, slug`,
        [ws.tenant_id, workspaceId, body.name, slug, body.description, body.contact, u.id],
      );
      // The creator becomes the first Project Admin so the project is never orphaned.
      await query(db, `INSERT INTO project_memberships (tenant_id, project_id, user_id, role) VALUES ($1,$2,$3,'project_admin')`, [ws.tenant_id, p.id, u.id]);
      await audit(db, req, { tenantId: ws.tenant_id, projectId: p.id, actorUserId: u.id, action: 'project.created', targetType: 'project', targetId: p.id, metadata: { name: body.name } });
      return p;
    });
    return reply.status(201).send(project);
  });

  app.get('/projects/:projectId', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const access = await loadProjectAccess(pool, u.id, projectId);
    const p = await one(
      pool,
      `SELECT p.*, w.name AS workspace_name, w.status AS workspace_status, t.name AS tenant_name,
              ou.display_name AS owner_name, ou.avatar_url AS owner_avatar
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id JOIN tenants t ON t.id = p.tenant_id
         LEFT JOIN users ou ON ou.id = p.owner_user_id WHERE p.id = $1`,
      [projectId],
    );
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      contact: p.contact,
      status: p.status,
      version: p.version,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      archivedAt: p.archived_at,
      writable: access.writable,
      tenant: { id: p.tenant_id, name: p.tenant_name },
      workspace: { id: p.workspace_id, name: p.workspace_name, status: p.workspace_status },
      owner: p.owner_user_id ? { id: p.owner_user_id, displayName: p.owner_name, avatarUrl: p.owner_avatar } : null,
      myRole: access.role,
      rolePermissions: access.permissions,
      permissions: Object.fromEntries(
        PERMISSION_KEYS.map((k) => [k, projectCan(access.role, k, access.permissions) && (access.writable || k === 'audit.view' || k === 'knowledge.view_archived' || k === 'project.archive')]),
      ),
    };
  });

  app.get('/projects/:projectId/overview', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const access = await requireProject(pool, u.id, projectId, 'knowledge.view');
    const vis = visibleTo('ki', '$2::text');
    const base = `FROM knowledge_items ki
      LEFT JOIN knowledge_categories c ON c.id = ki.category_id
      LEFT JOIN users ou ON ou.id = ki.owner_user_id
      LEFT JOIN files f ON f.id = ki.file_id
      WHERE ki.project_id = $1 AND ki.status = 'active' AND ${vis}`;
    const [pinned, recent, counts, categories, onboarding] = await Promise.all([
      query(pool, `SELECT ${ITEM_SUMMARY_COLUMNS} ${base} AND ki.is_pinned ORDER BY ki.updated_at DESC LIMIT 12`, [projectId, access.role]),
      query(pool, `SELECT ${ITEM_SUMMARY_COLUMNS} ${base} ORDER BY ki.updated_at DESC, ki.id DESC LIMIT 8`, [projectId, access.role]),
      one(pool, `SELECT count(*)::int AS total,
                        count(*) FILTER (WHERE ki.type = 'external_link')::int AS links,
                        count(*) FILTER (WHERE ki.type = 'uploaded_file')::int AS files,
                        count(*) FILTER (WHERE ki.type = 'internal_document')::int AS documents
                   FROM knowledge_items ki WHERE ki.project_id = $1 AND ki.status = 'active' AND ${vis}`, [projectId, access.role]),
      query(pool, `SELECT c.id, c.name, (SELECT count(*) FROM knowledge_items ki WHERE ki.category_id = c.id AND ki.status = 'active' AND ${vis})::int AS item_count
                     FROM knowledge_categories c WHERE c.project_id = $1 ORDER BY c.sort_order, c.name`, [projectId, access.role]),
      one(pool, `SELECT count(*) FILTER (WHERE s.is_required)::int AS required,
                        count(*) FILTER (WHERE s.is_required AND op.status = 'completed')::int AS completed,
                        count(*)::int AS steps
                   FROM onboarding_templates t JOIN onboarding_steps s ON s.template_id = t.id
                   LEFT JOIN onboarding_progress op ON op.step_id = s.id AND op.user_id = $3
                  WHERE t.project_id = $1 AND t.status = 'active' AND (t.target_role IS NULL OR t.target_role = $2)`, [projectId, access.role, u.id]),
    ]);
    return {
      pinned: pinned.map(itemSummary),
      recent: recent.map(itemSummary),
      counts,
      categories: categories.map((c) => ({ id: c.id, name: c.name, itemCount: c.item_count })),
      onboarding,
    };
  });

  app.patch('/projects/:projectId', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const body = parse(
      z.object({
        version: z.number().int().positive(),
        name: z.string().trim().min(2).max(80).optional(),
        description: z.string().trim().max(1000).optional(),
        contact: z.string().trim().max(200).optional(),
        ownerUserId: uuid.nullable().optional(),
      }),
      req.body,
    );
    await tx(async (db) => {
      const access = await requireProject(db, u.id, projectId, 'project.edit', { write: true });
      if (body.ownerUserId) {
        const m = await one(db, `SELECT 1 FROM project_memberships WHERE project_id = $1 AND user_id = $2 AND status = 'active'`, [projectId, body.ownerUserId]);
        if (!m) throw conflict('The project owner must be a member of the project.');
      }
      const updated = await one(
        db,
        `UPDATE projects SET name = coalesce($3, name), description = coalesce($4, description), contact = coalesce($5, contact),
                owner_user_id = CASE WHEN $6 THEN $7::uuid ELSE owner_user_id END,
                updated_at = now(), version = version + 1
          WHERE id = $1 AND version = $2 RETURNING id`,
        [projectId, body.version, body.name ?? null, body.description ?? null, body.contact ?? null,
         body.ownerUserId !== undefined, body.ownerUserId ?? null],
      );
      if (!updated) throw conflict('Someone else changed these settings. Reload and try again.');
      await audit(db, req, {
        tenantId: access.tenantId, projectId, actorUserId: u.id, action: 'project.updated',
        targetType: 'project', targetId: projectId,
        metadata: { fields: Object.keys(body).filter((k) => k !== 'version') },
      });
    });
    return { ok: true };
  });

  // Project RBAC table. Project Admins only: it decides what every other role can do.
  app.put('/projects/:projectId/role-permissions', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const row = z
      .object({
        create: z.boolean(), edit: z.enum(['none', 'own', 'all']), archive: z.boolean(), delete: z.boolean(), pin: z.boolean(),
        restrict: z.boolean(), categories: z.boolean(), onboarding: z.boolean(), audit: z.boolean(),
      })
      .partial()
      .strict();
    const body = parse(z.object({ permissions: z.object({ maintainer: row.optional(), member: row.optional(), viewer: row.optional() }).strict() }), req.body);
    const result = await tx(async (db) => {
      const access = await requireProject(db, u.id, projectId, 'project.manage_roles', { write: true });
      await query(db, 'SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
      const before = access.permissions;
      const after = normalizeProjectPermissions({
        maintainer: { ...before.maintainer, ...body.permissions.maintainer },
        member: { ...before.member, ...body.permissions.member },
        viewer: { ...before.viewer, ...body.permissions.viewer },
      });
      const changes = diffMatrix(before as any, after as any);
      if (changes.length === 0) return after;
      await query(db, 'UPDATE projects SET role_permissions = $2, updated_at = now() WHERE id = $1', [projectId, JSON.stringify(after)]);
      await audit(db, req, {
        tenantId: access.tenantId, projectId, actorUserId: u.id, action: 'project.permissions_changed', targetType: 'project', targetId: projectId,
        metadata: { changes },
      });
      return after;
    });
    return { rolePermissions: result };
  });

  const setStatus = (to: 'archived' | 'active') => async (req: any) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    await tx(async (db) => {
      const access = await requireProject(db, u.id, projectId, 'project.archive');
      await query(
        db,
        `UPDATE projects SET status = $2, archived_at = ${to === 'archived' ? 'now()' : 'NULL'}, updated_at = now(), version = version + 1 WHERE id = $1`,
        [projectId, to],
      );
      await audit(db, req, { tenantId: access.tenantId, projectId, actorUserId: u.id, action: to === 'archived' ? 'project.archived' : 'project.restored', targetType: 'project', targetId: projectId });
    });
    return { ok: true };
  };
  app.post('/projects/:projectId/archive', setStatus('archived'));
  app.post('/projects/:projectId/restore', setStatus('active'));
}
