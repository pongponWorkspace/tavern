// SQL-side twin of policy.itemPermissions().view. Visibility must be applied
// inside the query (not after it) so search results, counts, pagination and
// recent-activity feeds never reveal restricted items (§3.4, AC-013).

import { one, query, type Db } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { itemPermissions, type ItemRules } from '../authz/policy.js';
import { loadProjectAccess, type ProjectAccess } from '../authz/context.js';

/** `roleExpr` is a SQL expression yielding the caller's project role for row `alias`. */
export const visibleTo = (alias: string, roleExpr: string) =>
  `(${roleExpr} = 'project_admin' OR NOT EXISTS (
     SELECT 1 FROM knowledge_item_access_rules ar
      WHERE ar.knowledge_item_id = ${alias}.id AND ar.role = ${roleExpr} AND NOT ar.can_view))`;

export async function loadRules(db: Db, itemIds: string[]): Promise<Map<string, ItemRules>> {
  const map = new Map<string, ItemRules>();
  if (itemIds.length === 0) return map;
  const rows = await query(
    db,
    `SELECT knowledge_item_id, role, can_view, can_edit, can_archive FROM knowledge_item_access_rules WHERE knowledge_item_id = ANY($1::uuid[])`,
    [itemIds],
  );
  for (const r of rows) {
    const rules = map.get(r.knowledge_item_id) ?? {};
    (rules as any)[r.role] = { canView: r.can_view, canEdit: r.can_edit, canArchive: r.can_archive };
    map.set(r.knowledge_item_id, rules);
  }
  return map;
}

export interface LoadedItem {
  row: any;
  access: ProjectAccess;
  rules: ItemRules;
  perms: ReturnType<typeof itemPermissions>;
}

/**
 * Load a knowledge item for the caller. Non-members, users whose role cannot
 * view it, and permanently deleted items all produce the same 404 (AC-004, AC-010).
 */
export async function loadItemForUser(db: Db, userId: string, itemId: string, { lock = false } = {}): Promise<LoadedItem> {
  const row = await one(db, `SELECT * FROM knowledge_items WHERE id = $1 AND status <> 'deleted'${lock ? ' FOR UPDATE' : ''}`, [itemId]);
  if (!row) throw notFound('item');
  let access: ProjectAccess;
  try {
    access = await loadProjectAccess(db, userId, row.project_id);
  } catch {
    throw notFound('item');
  }
  if (access.tenantId !== row.tenant_id) throw notFound('item');
  const rules = (await loadRules(db, [row.id])).get(row.id) ?? {};
  const perms = itemPermissions(access.role, access.permissions, { createdBy: row.created_by }, userId, rules);
  if (!perms.view) throw notFound('item');
  // Archived items are only reachable by people who can manage archived content.
  if (row.status === 'archived' && !perms.archive && access.role !== 'project_admin') throw notFound('item');
  return { row, access, rules, perms };
}
