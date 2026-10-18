import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, pool, query, tx, type Db } from '../db/pool.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { decodeCursor, pageOf } from '../lib/pagination.js';
import { limitParam, parse, projectRole, uuid } from '../lib/validate.js';
import { slugify, validateExternalUrl } from '../lib/text.js';
import { audit } from '../audit.js';
import { assertWritable, requireProject, requireUser, type ProjectAccess } from '../authz/context.js';
import { buildItemRules, describeItemRules, itemPermissions, projectCan, type ItemRules } from '../authz/policy.js';
import { loadItemForUser, loadRules, visibleTo } from './knowledge-access.js';
import { removeStoredObject } from './files.js';

// ───────────────────────── Shared projections ─────────────────────────

export const ITEM_SUMMARY_COLUMNS = `
  ki.id, ki.project_id, ki.type, ki.title, ki.description, ki.external_url, ki.is_pinned, ki.status,
  ki.created_at, ki.updated_at, ki.created_by, ki.category_id, c.name AS category_name,
  ki.owner_user_id, ou.display_name AS owner_name, ou.avatar_url AS owner_avatar,
  f.scan_status AS file_scan_status, f.original_filename AS file_name, f.size_bytes AS file_size, f.mime_type AS file_mime,
  (SELECT coalesce(array_agg(tg.name ORDER BY tg.name), '{}') FROM knowledge_item_tags it
     JOIN knowledge_tags tg ON tg.id = it.tag_id WHERE it.knowledge_item_id = ki.id) AS tags`;

const ITEM_JOINS = `
  LEFT JOIN knowledge_categories c ON c.id = ki.category_id
  LEFT JOIN users ou ON ou.id = ki.owner_user_id
  LEFT JOIN files f ON f.id = ki.file_id`;

export function itemSummary(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type,
    title: r.title,
    description: r.description,
    externalUrl: r.external_url,
    isPinned: r.is_pinned,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    category: r.category_id ? { id: r.category_id, name: r.category_name } : null,
    owner: r.owner_user_id ? { id: r.owner_user_id, displayName: r.owner_name, avatarUrl: r.owner_avatar } : null,
    tags: r.tags ?? [],
    file: r.type === 'uploaded_file' ? { name: r.file_name, size: r.file_size, mimeType: r.file_mime, scanStatus: r.file_scan_status } : null,
  };
}

// ───────────────────────── Input schemas ─────────────────────────

const roleList = z.array(projectRole).max(4).optional();
const tagList = z.array(z.string().trim().min(1).max(40)).max(20).optional();
const accessFields = { visibilityRoles: roleList, editRoles: roleList, archiveRoles: roleList };

const createSchema = z.object({
  type: z.enum(['external_link', 'uploaded_file', 'internal_document']),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  externalUrl: z.string().trim().max(2000).optional(),
  fileId: uuid.optional(),
  content: z.string().max(200_000).optional(),
  categoryId: uuid.nullable().optional(),
  tags: tagList,
  ownerUserId: uuid.nullable().optional(),
  isPinned: z.boolean().optional(),
  ...accessFields,
});

const updateSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  externalUrl: z.string().trim().max(2000).optional(),
  categoryId: uuid.nullable().optional(),
  tags: tagList,
  ownerUserId: uuid.nullable().optional(),
  ...accessFields,
});

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(['external_link', 'uploaded_file', 'internal_document']).optional(),
  categoryId: z.union([uuid, z.literal('none')]).optional(),
  tag: z.string().trim().max(40).optional(),
  status: z.enum(['active', 'archived']).default('active'),
  pinned: z.enum(['true', 'false']).optional(),
  sort: z.enum(['updated', 'created', 'title']).default('updated'),
  order: z.enum(['asc', 'desc']).optional(),
  limit: limitParam,
  cursor: z.string().max(500).optional(),
});

// ───────────────────────── Helpers ─────────────────────────

async function assertCategory(db: Db, projectId: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const c = await one(db, 'SELECT 1 FROM knowledge_categories WHERE id = $1 AND project_id = $2', [categoryId, projectId]);
  if (!c) throw invalid('categoryId: that category does not exist in this project');
}

async function assertProjectMember(db: Db, projectId: string, userId: string | null | undefined) {
  if (!userId) return;
  const m = await one(db, `SELECT 1 FROM project_memberships WHERE project_id = $1 AND user_id = $2 AND status = 'active'`, [projectId, userId]);
  if (!m) throw invalid('ownerUserId: the owner must be a member of this project');
}

async function setTags(db: Db, access: ProjectAccess, itemId: string, tags: string[]) {
  await query(db, 'DELETE FROM knowledge_item_tags WHERE knowledge_item_id = $1', [itemId]);
  const seen = new Set<string>();
  for (const name of tags) {
    const slug = slugify(name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    const tag = await one(
      db,
      `INSERT INTO knowledge_tags (tenant_id, project_id, name, slug) VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, slug) DO UPDATE SET name = knowledge_tags.name RETURNING id`,
      [access.tenantId, access.projectId, name, slug],
    );
    await query(db, 'INSERT INTO knowledge_item_tags (project_id, knowledge_item_id, tag_id) VALUES ($1,$2,$3)', [access.projectId, itemId, tag.id]);
  }
}

async function writeRules(db: Db, access: ProjectAccess, itemId: string, rules: ItemRules, actorId: string) {
  await query(db, 'DELETE FROM knowledge_item_access_rules WHERE knowledge_item_id = $1', [itemId]);
  for (const [role, r] of Object.entries(rules)) {
    if (!r) continue;
    await query(
      db,
      `INSERT INTO knowledge_item_access_rules (tenant_id, project_id, knowledge_item_id, role, can_view, can_edit, can_archive, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [access.tenantId, access.projectId, itemId, role, r.canView, r.canEdit, r.canArchive, actorId],
    );
  }
}

/** Validate requested access lists; returns rules to store or null when none were sent. */
function resolveRules(access: ProjectAccess, body: { visibilityRoles?: any; editRoles?: any; archiveRoles?: any }, canRestrict: boolean) {
  if (!body.visibilityRoles && !body.editRoles && !body.archiveRoles) return null;
  if (!canRestrict) throw forbidden('Your role cannot restrict access to items in this project.');
  const { rules, errors } = buildItemRules(body, access.permissions);
  if (errors.length) throw invalid(errors[0], { errors });
  // A maintainer must not lock their own role out of an item they are configuring.
  if (access.role !== 'project_admin') {
    const own = rules[access.role];
    if (own && (!own.canView || !own.canEdit)) throw invalid('You cannot remove view or edit access from your own role.');
  }
  return rules;
}

/**
 * Maintainers may tighten an item's restrictions but not loosen them, so they
 * can't undo limits a Project Admin set (e.g. re-expose a hidden item).
 */
function assertNoWidening(access: ProjectAccess, current: ItemRules, next: ItemRules) {
  if (access.role === 'project_admin') return;
  for (const role of ['maintainer', 'member', 'viewer'] as const) {
    const cur = current[role];
    if (!cur) continue;
    const n = next[role] ?? { canView: true, canEdit: true, canArchive: true };
    if ((n.canView && !cur.canView) || (n.canEdit && !cur.canEdit) || (n.canArchive && !cur.canArchive)) {
      throw forbidden('Only a Project Admin can loosen access restrictions on this item.');
    }
  }
}

/** Visible items in the same project that already use this URL (P1 duplicate warning). */
async function findDuplicates(db: Db, access: ProjectAccess, normalizedUrl: string, excludeId?: string) {
  return query(
    db,
    `SELECT ki.id, ki.title FROM knowledge_items ki
      WHERE ki.project_id = $1 AND ki.tenant_id = $2 AND ki.status = 'active' AND ki.normalized_url = $3
        AND ($4::uuid IS NULL OR ki.id <> $4) AND ${visibleTo('ki', '$5::text')}
      LIMIT 5`,
    [access.projectId, access.tenantId, normalizedUrl, excludeId ?? null, access.role],
  );
}

async function itemDetail(db: Db, userId: string, itemId: string) {
  const { row, access, rules, perms } = await loadItemForUser(db, userId, itemId);
  const full = await one(
    db,
    `SELECT ${ITEM_SUMMARY_COLUMNS}, ki.version, ki.file_id, ki.archived_at,
            cu.display_name AS created_by_name, uu.display_name AS updated_by_name, ki.updated_by,
            p.name AS project_name
       FROM knowledge_items ki ${ITEM_JOINS}
       JOIN users cu ON cu.id = ki.created_by
       JOIN users uu ON uu.id = ki.updated_by
       JOIN projects p ON p.id = ki.project_id
      WHERE ki.id = $1`,
    [row.id],
  );
  return {
    ...itemSummary(full),
    version: full.version,
    archivedAt: full.archived_at,
    project: { id: access.projectId, name: full.project_name },
    createdBy: { id: full.created_by, displayName: full.created_by_name },
    updatedBy: { id: full.updated_by, displayName: full.updated_by_name },
    file: full.file_id
      ? { id: full.file_id, name: full.file_name, size: full.file_size, mimeType: full.file_mime, scanStatus: full.file_scan_status }
      : null,
    permissions: {
      edit: perms.edit && access.writable,
      archive: perms.archive && access.writable,
      delete: perms.delete && access.writable,
      pin: perms.pin && access.writable,
      restrict: perms.restrict && access.writable,
    },
    // Visibility summary only for people allowed to manage it (§4.3 Knowledge Detail).
    access: perms.restrict ? describeItemRules(rules, access.permissions) : undefined,
  };
}

// ───────────────────────── Routes ─────────────────────────

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get('/projects/:projectId/knowledge', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const q = parse(listSchema, req.query);
    const access = await requireProject(pool, u.id, projectId, 'knowledge.view');
    if (q.status === 'archived' && !projectCan(access.role, 'knowledge.view_archived', access.permissions)) throw forbidden();

    const params: unknown[] = [access.projectId, access.tenantId, q.status, access.role];
    const where: string[] = ['ki.project_id = $1', 'ki.tenant_id = $2', 'ki.status = $3', visibleTo('ki', '$4::text')];
    const add = (sql: (n: string) => string, value: unknown) => {
      params.push(value);
      where.push(sql(`$${params.length}`));
    };
    if (q.type) add((p) => `ki.type = ${p}`, q.type);
    if (q.categoryId === 'none') where.push('ki.category_id IS NULL');
    else if (q.categoryId) add((p) => `ki.category_id = ${p}`, q.categoryId);
    if (q.pinned) add((p) => `ki.is_pinned = ${p}`, q.pinned === 'true');
    if (q.tag) {
      add((p) => `EXISTS (SELECT 1 FROM knowledge_item_tags it JOIN knowledge_tags tg ON tg.id = it.tag_id WHERE it.knowledge_item_id = ki.id AND tg.slug = ${p})`, slugify(q.tag));
    }
    if (q.q) {
      params.push(q.q);
      const tsq = `$${params.length}`;
      params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const like = `$${params.length}`;
      where.push(`(ki.search_vector @@ plainto_tsquery('simple', ${tsq}) OR ki.title ILIKE ${like} OR ki.description ILIKE ${like}
        OR EXISTS (SELECT 1 FROM knowledge_item_tags it JOIN knowledge_tags tg ON tg.id = it.tag_id WHERE it.knowledge_item_id = ki.id AND tg.name ILIKE ${like}))`);
    }

    // Counts use the same authorization-filtered predicate as the page (AC-013).
    const total = (await one(pool, `SELECT count(*)::int AS n FROM knowledge_items ki WHERE ${where.join(' AND ')}`, params))!.n;

    const sortCol = q.sort === 'title' ? 'lower(ki.title)' : q.sort === 'created' ? 'ki.created_at' : 'ki.updated_at';
    const order = q.order ?? (q.sort === 'title' ? 'asc' : 'desc');
    const cmp = order === 'asc' ? '>' : '<';
    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      params.push(cursor[0], cursor[1]);
      const cast = q.sort === 'title' ? 'text' : 'timestamptz';
      where.push(`(${sortCol}, ki.id) ${cmp} ($${params.length - 1}::${cast}, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    // The cursor key is rendered by Postgres so timestamps keep microsecond precision.
    const sortKey = q.sort === 'title' ? sortCol : `to_char(${sortCol} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const rows = await query(
      pool,
      `SELECT ${ITEM_SUMMARY_COLUMNS}, ${sortKey} AS sort_key FROM knowledge_items ki ${ITEM_JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortCol} ${order}, ki.id ${order} LIMIT $${params.length}`,
      params,
    );
    const page = pageOf(rows, q.limit, (r) => r.sort_key);
    const rules = await loadRules(pool, page.data.map((r) => r.id));
    return {
      data: page.data.map((r) => {
        const perms = itemPermissions(access.role, access.permissions, { createdBy: r.created_by }, u.id, rules.get(r.id) ?? {});
        return {
          ...itemSummary(r),
          permissions: { edit: perms.edit && access.writable, archive: perms.archive && access.writable, pin: perms.pin && access.writable, delete: perms.delete && access.writable },
        };
      }),
      page: { nextCursor: page.nextCursor, total },
    };
  });

  app.get('/projects/:projectId/knowledge/duplicates', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const q = parse(z.object({ url: z.string().max(2000), excludeId: uuid.optional() }), req.query);
    const access = await requireProject(pool, u.id, projectId, 'knowledge.create');
    let normalized: string;
    try {
      normalized = validateExternalUrl(q.url).normalized;
    } catch {
      return { data: [] };
    }
    return { data: await findDuplicates(pool, access, normalized, q.excludeId) };
  });

  app.post('/projects/:projectId/knowledge', async (req, reply) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const body = parse(createSchema, req.body);

    const result = await tx(async (db) => {
      const access = await requireProject(db, u.id, projectId, 'knowledge.create', { write: true });
      const rules = resolveRules(access, body, projectCan(access.role, 'knowledge.restrict', access.permissions));
      if (body.isPinned && access.role !== 'project_admin' && !access.permissions[access.role].pin) throw forbidden('Your role cannot pin items in this project.');
      await assertCategory(db, access.projectId, body.categoryId);
      await assertProjectMember(db, access.projectId, body.ownerUserId);

      let externalUrl: string | null = null;
      let normalizedUrl: string | null = null;
      let fileId: string | null = null;
      if (body.type === 'external_link') {
        if (!body.externalUrl) throw invalid('externalUrl: a link is required');
        const v = validateExternalUrl(body.externalUrl);
        externalUrl = v.display;
        normalizedUrl = v.normalized;
      } else if (body.type === 'uploaded_file') {
        if (!body.fileId) throw invalid('fileId: upload a file first');
        // Re-verify file scope and ownership at association time (§11: upload after revocation).
        const file = await one(
          db,
          `SELECT f.id FROM files f WHERE f.id = $1 AND f.project_id = $2 AND f.tenant_id = $3 AND f.deleted_at IS NULL
              AND f.upload_state = 'completed' AND (f.uploaded_by = $4 OR $5 = 'project_admin')
              AND NOT EXISTS (SELECT 1 FROM knowledge_items k WHERE k.file_id = f.id AND k.status <> 'deleted')
            FOR UPDATE`,
          [body.fileId, access.projectId, access.tenantId, u.id, access.role],
        );
        if (!file) throw invalid('fileId: that upload is not available — upload the file again');
        fileId = file.id;
      }

      const item = await one(
        db,
        `INSERT INTO knowledge_items (tenant_id, project_id, category_id, type, title, description, external_url, normalized_url,
                                      file_id, owner_user_id, created_by, updated_by, is_pinned)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12) RETURNING id`,
        [access.tenantId, access.projectId, body.categoryId ?? null, body.type, body.title, body.description, externalUrl, normalizedUrl,
         fileId, body.ownerUserId === undefined ? u.id : body.ownerUserId, u.id, body.isPinned ?? false],
      );
      if (body.type === 'internal_document') {
        await query(db, `INSERT INTO knowledge_documents (knowledge_item_id, tenant_id, project_id, content_md, updated_by) VALUES ($1,$2,$3,$4,$5)`,
          [item.id, access.tenantId, access.projectId, body.content ?? '', u.id]);
      }
      if (body.tags?.length) await setTags(db, access, item.id, body.tags);
      if (rules) await writeRules(db, access, item.id, rules, u.id);
      await audit(db, req, {
        tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'knowledge.created',
        targetType: 'knowledge_item', targetId: item.id, metadata: { type: body.type, title: body.title, restricted: Boolean(rules && Object.keys(rules).length) },
      });
      const duplicates = normalizedUrl ? await findDuplicates(db, access, normalizedUrl, item.id) : [];
      return { id: item.id, duplicates };
    });
    const detail = await itemDetail(pool, u.id, result.id);
    return reply.status(201).send({ ...detail, warnings: result.duplicates.length ? { duplicateUrl: result.duplicates } : undefined });
  });

  app.get('/knowledge/:itemId', async (req) => {
    const u = requireUser(req);
    const { itemId } = parse(z.object({ itemId: uuid }), req.params);
    return itemDetail(pool, u.id, itemId);
  });

  app.patch('/knowledge/:itemId', async (req) => {
    const u = requireUser(req);
    const { itemId } = parse(z.object({ itemId: uuid }), req.params);
    const body = parse(updateSchema, req.body);
    await tx(async (db) => {
      const { row, access, perms, rules: currentRules } = await loadItemForUser(db, u.id, itemId, { lock: true });
      if (!perms.edit) throw forbidden();
      assertWritable(access);
      if (row.status !== 'active') throw conflict('Restore this item before editing it.');
      if (row.version !== body.version) {
        throw conflict('Someone else changed this item while you were editing. Reload to see their changes.', { currentVersion: row.version });
      }
      const rules = resolveRules(access, body, perms.restrict);
      if (rules) assertNoWidening(access, currentRules, rules);
      await assertCategory(db, access.projectId, body.categoryId);
      await assertProjectMember(db, access.projectId, body.ownerUserId);

      let externalUrl = row.external_url;
      let normalizedUrl = row.normalized_url;
      if (body.externalUrl !== undefined) {
        if (row.type !== 'external_link') throw invalid('externalUrl: only links have a URL');
        const v = validateExternalUrl(body.externalUrl);
        externalUrl = v.display;
        normalizedUrl = v.normalized;
      }
      await query(
        db,
        `UPDATE knowledge_items SET
           title = coalesce($2, title), description = coalesce($3, description),
           external_url = $4, normalized_url = $5,
           category_id = CASE WHEN $6 THEN $7::uuid ELSE category_id END,
           owner_user_id = CASE WHEN $8 THEN $9::uuid ELSE owner_user_id END,
           updated_by = $10, updated_at = now(), version = version + 1
         WHERE id = $1`,
        [itemId, body.title ?? null, body.description ?? null, externalUrl, normalizedUrl,
         body.categoryId !== undefined, body.categoryId ?? null, body.ownerUserId !== undefined, body.ownerUserId ?? null, u.id],
      );
      if (body.tags) await setTags(db, access, itemId, body.tags);
      const changed = Object.keys(body).filter((k) => k !== 'version' && !k.endsWith('Roles'));
      await audit(db, req, {
        tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'knowledge.updated',
        targetType: 'knowledge_item', targetId: itemId, metadata: { fields: changed },
      });
      if (rules) {
        await writeRules(db, access, itemId, rules, u.id);
        const d = describeItemRules(rules, access.permissions);
        await audit(db, req, {
          tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'knowledge.access_changed',
          targetType: 'knowledge_item', targetId: itemId, metadata: { visibilityRoles: d.visibilityRoles, editRoles: d.editRoles, archiveRoles: d.archiveRoles },
        });
      }
    });
    return itemDetail(pool, u.id, itemId);
  });

  const statusChange = (action: 'archive' | 'restore') => async (req: any) => {
    const u = requireUser(req);
    const { itemId } = parse(z.object({ itemId: uuid }), req.params);
    await tx(async (db) => {
      const { row, access, perms } = await loadItemForUser(db, u.id, itemId, { lock: true });
      if (!perms.archive) throw forbidden();
      assertWritable(access);
      const [from, to] = action === 'archive' ? ['active', 'archived'] : ['archived', 'active'];
      if (row.status !== from) return;
      await query(
        db,
        `UPDATE knowledge_items SET status = $2, archived_at = ${to === 'archived' ? 'now()' : 'NULL'}, is_pinned = CASE WHEN $2 = 'archived' THEN false ELSE is_pinned END,
                updated_by = $3, updated_at = now(), version = version + 1 WHERE id = $1`,
        [itemId, to, u.id],
      );
      await audit(db, req, {
        tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: `knowledge.${action === 'archive' ? 'archived' : 'restored'}`,
        targetType: 'knowledge_item', targetId: itemId, metadata: { title: row.title },
      });
    });
    return itemDetail(pool, u.id, itemId);
  };
  app.post('/knowledge/:itemId/archive', statusChange('archive'));
  app.post('/knowledge/:itemId/restore', statusChange('restore'));

  app.delete('/knowledge/:itemId', async (req) => {
    const u = requireUser(req);
    const { itemId } = parse(z.object({ itemId: uuid }), req.params);
    const storageKey = await tx(async (db) => {
      const { row, access, perms } = await loadItemForUser(db, u.id, itemId, { lock: true });
      if (!perms.delete) throw forbidden();
      assertWritable(access);
      if (row.status !== 'archived') throw conflict('Archive this item before deleting it permanently.');
      await query(db, 'DELETE FROM knowledge_items WHERE id = $1', [itemId]);
      let key: string | null = null;
      if (row.file_id) {
        const f = await one(db, `UPDATE files SET deleted_at = now() WHERE id = $1 RETURNING storage_key`, [row.file_id]);
        key = f?.storage_key ?? null;
      }
      await audit(db, req, {
        tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'knowledge.deleted',
        targetType: 'knowledge_item', targetId: itemId, metadata: { title: row.title, type: row.type },
      });
      return key;
    });
    // The DB no longer references the object; remove it after commit (orphan cleanup also catches failures).
    if (storageKey) await removeStoredObject(storageKey).catch(() => {});
    return { ok: true };
  });

  const pin = (pinned: boolean) => async (req: any) => {
    const u = requireUser(req);
    const { itemId } = parse(z.object({ itemId: uuid }), req.params);
    await tx(async (db) => {
      const { row, access, perms } = await loadItemForUser(db, u.id, itemId, { lock: true });
      if (!perms.pin) throw forbidden();
      assertWritable(access);
      if (row.status !== 'active') throw conflict('Only active items can be pinned.');
      await query(db, 'UPDATE knowledge_items SET is_pinned = $2 WHERE id = $1', [itemId, pinned]);
      await audit(db, req, {
        tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: pinned ? 'knowledge.pinned' : 'knowledge.unpinned',
        targetType: 'knowledge_item', targetId: itemId,
      });
    });
    return { ok: true, isPinned: pinned };
  };
  app.post('/knowledge/:itemId/pin', pin(true));
  app.delete('/knowledge/:itemId/pin', pin(false));

  // ───────────── Internal document content ─────────────

  app.get('/knowledge/:itemId/content', async (req) => {
    const u = requireUser(req);
    const { itemId } = parse(z.object({ itemId: uuid }), req.params);
    const { row } = await loadItemForUser(pool, u.id, itemId);
    if (row.type !== 'internal_document') throw notFound('document');
    const doc = await one(
      pool,
      `SELECT d.content_md, d.updated_at, u.id AS editor_id, u.display_name AS editor_name
         FROM knowledge_documents d JOIN users u ON u.id = d.updated_by WHERE d.knowledge_item_id = $1`,
      [itemId],
    );
    return {
      content: doc?.content_md ?? '',
      format: 'markdown',
      updatedAt: doc?.updated_at ?? row.updated_at,
      updatedBy: doc ? { id: doc.editor_id, displayName: doc.editor_name } : null,
      version: row.version,
    };
  });

  app.put('/knowledge/:itemId/content', async (req) => {
    const u = requireUser(req);
    const { itemId } = parse(z.object({ itemId: uuid }), req.params);
    const body = parse(z.object({ content: z.string().max(200_000), version: z.number().int().positive() }), req.body);
    const version = await tx(async (db) => {
      const { row, access, perms } = await loadItemForUser(db, u.id, itemId, { lock: true });
      if (row.type !== 'internal_document') throw notFound('document');
      if (!perms.edit) throw forbidden(); // re-checked at save time (§11 "loses role while editing")
      assertWritable(access);
      if (row.status !== 'active') throw conflict('Restore this document before editing it.');
      if (row.version !== body.version) {
        throw conflict('Someone else saved this document while you were editing. Copy your changes, then reload.', { currentVersion: row.version });
      }
      await query(
        db,
        `INSERT INTO knowledge_documents (knowledge_item_id, tenant_id, project_id, content_md, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (knowledge_item_id) DO UPDATE SET content_md = excluded.content_md, updated_by = excluded.updated_by, updated_at = now()`,
        [itemId, access.tenantId, access.projectId, body.content, u.id],
      );
      const r = await one(db, 'UPDATE knowledge_items SET updated_by = $2, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING version', [itemId, u.id]);
      await audit(db, req, {
        tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'knowledge.content_updated',
        targetType: 'knowledge_item', targetId: itemId, metadata: { length: body.content.length },
      });
      return r.version as number;
    });
    return { ok: true, version };
  });

  // ───────────── Categories & tags ─────────────

  app.get('/projects/:projectId/categories', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const access = await requireProject(pool, u.id, projectId, 'knowledge.view');
    const rows = await query(
      pool,
      `SELECT c.id, c.name, c.slug, c.description, c.sort_order,
              (SELECT count(*) FROM knowledge_items ki WHERE ki.category_id = c.id AND ki.status = 'active' AND ${visibleTo('ki', '$2::text')}) AS item_count
         FROM knowledge_categories c WHERE c.project_id = $1 ORDER BY c.sort_order, c.name`,
      [access.projectId, access.role],
    );
    const uncategorized = await one(
      pool,
      `SELECT count(*)::int AS n FROM knowledge_items ki WHERE ki.project_id = $1 AND ki.category_id IS NULL AND ki.status = 'active' AND ${visibleTo('ki', '$2::text')}`,
      [access.projectId, access.role],
    );
    return {
      data: rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, description: c.description, sortOrder: c.sort_order, itemCount: c.item_count })),
      uncategorizedCount: uncategorized!.n,
    };
  });

  app.post('/projects/:projectId/categories', async (req, reply) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(300).default(''), sortOrder: z.number().int().min(0).max(1000).optional() }), req.body);
    const cat = await tx(async (db) => {
      const access = await requireProject(db, u.id, projectId, 'category.manage', { write: true });
      const slug = slugify(body.name);
      if (await one(db, 'SELECT 1 FROM knowledge_categories WHERE project_id = $1 AND slug = $2', [projectId, slug])) {
        throw conflict('A category with that name already exists.');
      }
      const c = await one(
        db,
        `INSERT INTO knowledge_categories (tenant_id, project_id, name, slug, description, sort_order)
         VALUES ($1,$2,$3,$4,$5, coalesce($6, (SELECT coalesce(max(sort_order),0)+1 FROM knowledge_categories WHERE project_id = $2)))
         RETURNING id, name, slug, description, sort_order`,
        [access.tenantId, projectId, body.name, slug, body.description, body.sortOrder ?? null],
      );
      await audit(db, req, { tenantId: access.tenantId, projectId, actorUserId: u.id, action: 'category.created', targetType: 'category', targetId: c.id, metadata: { name: body.name } });
      return c;
    });
    return reply.status(201).send({ id: cat.id, name: cat.name, slug: cat.slug, description: cat.description, sortOrder: cat.sort_order, itemCount: 0 });
  });

  app.patch('/categories/:categoryId', async (req) => {
    const u = requireUser(req);
    const { categoryId } = parse(z.object({ categoryId: uuid }), req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(60).optional(), description: z.string().trim().max(300).optional(), sortOrder: z.number().int().min(0).max(1000).optional() }), req.body);
    await tx(async (db) => {
      const cat = await one(db, 'SELECT project_id FROM knowledge_categories WHERE id = $1', [categoryId]);
      if (!cat) throw notFound('category');
      const access = await requireProject(db, u.id, cat.project_id, 'category.manage', { write: true }).catch((e) => {
        throw e.status === 404 ? notFound('category') : e;
      });
      await query(
        db,
        `UPDATE knowledge_categories SET name = coalesce($2, name), slug = CASE WHEN $2 IS NULL THEN slug ELSE $5 END,
                description = coalesce($3, description), sort_order = coalesce($4, sort_order), updated_at = now() WHERE id = $1`,
        [categoryId, body.name ?? null, body.description ?? null, body.sortOrder ?? null, body.name ? slugify(body.name) : null],
      );
      await audit(db, req, { tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'category.updated', targetType: 'category', targetId: categoryId, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });

  app.delete('/categories/:categoryId', async (req) => {
    const u = requireUser(req);
    const { categoryId } = parse(z.object({ categoryId: uuid }), req.params);
    const q = parse(z.object({ reassignTo: z.union([uuid, z.literal('none')]).optional() }), req.query);
    await tx(async (db) => {
      const cat = await one(db, 'SELECT project_id, name FROM knowledge_categories WHERE id = $1', [categoryId]);
      if (!cat) throw notFound('category');
      const access = await requireProject(db, u.id, cat.project_id, 'category.manage', { write: true }).catch((e) => {
        throw e.status === 404 ? notFound('category') : e;
      });
      const inUse = await one(db, `SELECT 1 FROM knowledge_items WHERE category_id = $1 LIMIT 1`, [categoryId]);
      if (inUse) {
        if (!q.reassignTo) throw conflict('This category still has items. Choose where to move them first.');
        const target = q.reassignTo === 'none' ? null : q.reassignTo;
        if (target === categoryId) throw invalid('reassignTo: choose a different category');
        await assertCategory(db, cat.project_id, target);
        await query(db, 'UPDATE knowledge_items SET category_id = $2 WHERE category_id = $1', [categoryId, target]);
      }
      await query(db, 'DELETE FROM knowledge_categories WHERE id = $1', [categoryId]);
      await audit(db, req, { tenantId: access.tenantId, projectId: access.projectId, actorUserId: u.id, action: 'category.deleted', targetType: 'category', targetId: categoryId, metadata: { name: cat.name } });
    });
    return { ok: true };
  });

  app.get('/projects/:projectId/tags', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const q = parse(z.object({ scope: z.enum(['active', 'all']).default('active') }), req.query);
    const access = await requireProject(pool, u.id, projectId, 'knowledge.view');
    // scope=all (the tag picker) also counts archived items, but only for roles
    // that may see archived content. Either way, only tags on items the caller
    // can see are returned, so tag names can't leak restricted items.
    const includeArchived = q.scope === 'all' && projectCan(access.role, 'knowledge.view_archived', access.permissions);
    const rows = await query(
      pool,
      `SELECT tg.name, tg.slug, count(*) FILTER (WHERE ki.status = 'active')::int AS item_count
         FROM knowledge_tags tg JOIN knowledge_item_tags it ON it.tag_id = tg.id
         JOIN knowledge_items ki ON ki.id = it.knowledge_item_id
        WHERE tg.project_id = $1 AND ${visibleTo('ki', '$2::text')}
          AND (ki.status = 'active' OR ($3 AND ki.status = 'archived'))
        GROUP BY tg.name, tg.slug ORDER BY item_count DESC, tg.name LIMIT 200`,
      [access.projectId, access.role, includeArchived],
    );
    return { data: rows.map((t) => ({ name: t.name, slug: t.slug, itemCount: t.item_count })) };
  });
}
