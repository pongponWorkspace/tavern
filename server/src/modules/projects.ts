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
      actualRole: access.actualRole,
      previewing: access.previewing,
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

  // Start a new project from this one (P1 "project templates"): structure always, links and documents optionally.
  app.post('/projects/:projectId/duplicate', async (req, reply) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const body = parse(z.object({ name: z.string().trim().min(2).max(80), includeContent: z.boolean().default(true) }), req.body);
    const created = await tx(async (db) => {
      const src = await requireProject(db, u.id, projectId, 'project.edit');
      await requireTenant(db, u.id, src.tenantId, 'project.create').catch((e) => {
        throw e.status === 404 ? notFound('project') : e;
      });
      const ws = await one(db, `SELECT status FROM workspaces WHERE id = $1`, [src.workspaceId]);
      if (ws.status !== 'active') throw readOnly();
      const p = await one(db, `SELECT * FROM projects WHERE id = $1`, [projectId]);
      let slug = slugify(body.name);
      if (await one(db, 'SELECT 1 FROM projects WHERE workspace_id = $1 AND slug = $2', [src.workspaceId, slug])) slug = `${slug}-${randomToken(3).toLowerCase()}`;
      const np = await one(
        db,
        `INSERT INTO projects (tenant_id, workspace_id, name, slug, description, contact, owner_user_id, created_by, role_permissions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) RETURNING id`,
        [src.tenantId, src.workspaceId, body.name, slug, p.description, p.contact, u.id, p.role_permissions],
      );
      const newId: string = np.id;
      await query(db, `INSERT INTO project_memberships (tenant_id, project_id, user_id, role) VALUES ($1,$2,$3,'project_admin')`, [src.tenantId, newId, u.id]);

      const catMap = new Map<string, string>();
      for (const c of await query(db, `SELECT * FROM knowledge_categories WHERE project_id = $1 ORDER BY sort_order`, [projectId])) {
        const nc = await one(db, `INSERT INTO knowledge_categories (tenant_id, project_id, name, slug, description, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [src.tenantId, newId, c.name, c.slug, c.description, c.sort_order]);
        catMap.set(c.id, nc.id);
      }

      const itemMap = new Map<string, string>();
      if (body.includeContent) {
        const tagMap = new Map<string, string>();
        const items = await query(db, `SELECT * FROM knowledge_items WHERE project_id = $1 AND status = 'active' AND type IN ('external_link','internal_document') ORDER BY created_at`, [projectId]);
        for (const it of items) {
          const ni = await one(
            db,
            `INSERT INTO knowledge_items (tenant_id, project_id, category_id, type, title, description, external_url, normalized_url, owner_user_id, created_by, updated_by, is_pinned)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9,$10) RETURNING id`,
            [src.tenantId, newId, it.category_id ? catMap.get(it.category_id) ?? null : null, it.type, it.title, it.description, it.external_url, it.normalized_url, u.id, it.is_pinned],
          );
          itemMap.set(it.id, ni.id);
          if (it.type === 'internal_document') {
            const d = await one(db, `SELECT content_md FROM knowledge_documents WHERE knowledge_item_id = $1`, [it.id]);
            const content = d?.content_md ?? '';
            await query(db, `INSERT INTO knowledge_documents (knowledge_item_id, tenant_id, project_id, content_md, updated_by) VALUES ($1,$2,$3,$4,$5)`, [ni.id, src.tenantId, newId, content, u.id]);
            await query(db, `INSERT INTO knowledge_document_revisions (tenant_id, project_id, knowledge_item_id, content_md, created_by) VALUES ($1,$2,$3,$4,$5)`, [src.tenantId, newId, ni.id, content, u.id]);
          }
          for (const t of await query(db, `SELECT tg.name, tg.slug FROM knowledge_item_tags it JOIN knowledge_tags tg ON tg.id = it.tag_id WHERE it.knowledge_item_id = $1`, [it.id])) {
            if (!tagMap.has(t.slug)) {
              const nt = await one(db, `INSERT INTO knowledge_tags (tenant_id, project_id, name, slug) VALUES ($1,$2,$3,$4) RETURNING id`, [src.tenantId, newId, t.name, t.slug]);
              tagMap.set(t.slug, nt.id);
            }
            await query(db, `INSERT INTO knowledge_item_tags (project_id, knowledge_item_id, tag_id) VALUES ($1,$2,$3)`, [newId, ni.id, tagMap.get(t.slug)]);
          }
          await query(
            db,
            `INSERT INTO knowledge_item_access_rules (tenant_id, project_id, knowledge_item_id, role, can_view, can_edit, can_archive, created_by, updated_by)
             SELECT $1, $2, $3, role, can_view, can_edit, can_archive, $4, $4 FROM knowledge_item_access_rules WHERE knowledge_item_id = $5`,
            [src.tenantId, newId, ni.id, u.id, it.id],
          );
        }
      }

      for (const t of await query(db, `SELECT * FROM onboarding_templates WHERE project_id = $1 AND status = 'active' ORDER BY created_at`, [projectId])) {
        const nt = await one(db, `INSERT INTO onboarding_templates (tenant_id, project_id, name, description, target_role, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
          [src.tenantId, newId, t.name, t.description, t.target_role, u.id]);
        for (const st of await query(db, `SELECT * FROM onboarding_steps WHERE template_id = $1 ORDER BY sort_order, created_at`, [t.id])) {
          await query(
            db,
            `INSERT INTO onboarding_steps (tenant_id, project_id, template_id, knowledge_item_id, title, instructions, sort_order, is_required, due_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [src.tenantId, newId, nt.id, st.knowledge_item_id ? itemMap.get(st.knowledge_item_id) ?? null : null, st.title, st.instructions, st.sort_order, st.is_required, st.due_days],
          );
        }
      }

      await audit(db, req, {
        tenantId: src.tenantId, projectId: newId, actorUserId: u.id, action: 'project.created', targetType: 'project', targetId: newId,
        metadata: { name: body.name, duplicatedFrom: p.name, items: itemMap.size },
      });
      return { id: newId };
    });
    return reply.status(201).send(created);
  });

  // Things a Project Admin should act on: invitation links about to expire, files that failed the scan.
  app.get('/projects/:projectId/attention', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    await requireProject(pool, u.id, projectId, 'members.manage');
    const [invites, files] = await Promise.all([
      query(
        pool,
        `SELECT id, target_role, email_restriction, expires_at, use_count, max_uses FROM invitations
          WHERE project_id = $1 AND status = 'active' AND expires_at > now() AND expires_at < now() + interval '48 hours'
          ORDER BY expires_at`,
        [projectId],
      ),
      query(
        pool,
        `SELECT f.id, f.safe_filename, f.scan_status, ki.id AS item_id, ki.title
           FROM files f LEFT JOIN knowledge_items ki ON ki.file_id = f.id AND ki.status <> 'deleted'
          WHERE f.project_id = $1 AND f.deleted_at IS NULL AND f.scan_status IN ('quarantined','failed')
          ORDER BY f.created_at DESC LIMIT 20`,
        [projectId],
      ),
    ]);
    return {
      expiringInvitations: invites.map((i) => ({ id: i.id, role: i.target_role, email: i.email_restriction, expiresAt: i.expires_at, useCount: i.use_count, maxUses: i.max_uses })),
      blockedFiles: files.map((f) => ({ id: f.id, filename: f.safe_filename, scanStatus: f.scan_status, item: f.item_id ? { id: f.item_id, title: f.title } : null })),
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
