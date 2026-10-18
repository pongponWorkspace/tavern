import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool, query } from '../db/pool.js';
import { decodeCursor, pageOf } from '../lib/pagination.js';
import { limitParam, parse, uuid } from '../lib/validate.js';
import { requireProject, requireTenant, requireUser } from '../authz/context.js';
import { audit } from '../audit.js';
import { toCsv } from '../lib/csv.js';

const filters = z.object({
  action: z.string().max(60).optional(),
  actorId: uuid.optional(),
  outcome: z.enum(['success', 'denied', 'failure']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: limitParam,
  cursor: z.string().max(300).optional(),
});

type Scope = { column: 'project_id' | 'tenant_id'; id: string; tenantLevelOnly?: boolean };

async function listAudit(scope: Scope, q: z.infer<typeof filters>, max?: number) {
  const params: unknown[] = [scope.id];
  const where = [`a.${scope.column} = $1`];
  if (scope.tenantLevelOnly) where.push('a.project_id IS NULL');
  const add = (sql: (p: string) => string, v: unknown) => {
    params.push(v);
    where.push(sql(`$${params.length}`));
  };
  if (q.action) add((p) => `a.action LIKE ${p}`, `${q.action.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  if (q.actorId) add((p) => `a.actor_user_id = ${p}`, q.actorId);
  if (q.outcome) add((p) => `a.outcome = ${p}`, q.outcome);
  if (q.from) add((p) => `a.created_at >= ${p}`, q.from);
  if (q.to) add((p) => `a.created_at < ${p}`, q.to);
  const cursor = decodeCursor(q.cursor);
  if (cursor) {
    params.push(cursor[0], cursor[1]);
    where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push((max ?? q.limit) + 1);
  const rows = await query(
    pool,
    `SELECT a.id, a.action, a.target_type, a.target_id, a.outcome, a.metadata_json, a.request_id, a.created_at, a.project_id,
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key,
            u.id AS actor_id, u.display_name AS actor_name, tu.display_name AS target_user_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN users tu ON a.target_type = 'user' AND tu.id::text = a.target_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
    params,
  );
  const page = pageOf(rows, max ?? q.limit, (r) => r.sort_key);
  return {
    data: page.data.map((r) => ({
      id: r.id, action: r.action, targetType: r.target_type, targetId: r.target_id, targetLabel: r.target_user_name ?? r.metadata_json?.title ?? r.metadata_json?.name ?? null,
      outcome: r.outcome, metadata: r.metadata_json, requestId: r.request_id, createdAt: r.created_at,
      actor: r.actor_id ? { id: r.actor_id, displayName: r.actor_name } : null,
    })),
    page: { nextCursor: page.nextCursor },
  };
}

const EXPORT_MAX = 10_000;

function sendCsv(reply: FastifyReply, filename: string, data: Awaited<ReturnType<typeof listAudit>>['data']) {
  const csv = toCsv(
    ['When (UTC)', 'Who', 'Action', 'Target', 'Outcome', 'Details', 'Request ID'],
    data.map((r) => [
      r.createdAt, r.actor?.displayName ?? 'System', r.action, r.targetLabel ?? r.targetId ?? '', r.outcome,
      Object.entries(r.metadata ?? {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join('; '), r.requestId ?? '',
    ]),
  );
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}"`)
    .header('cache-control', 'no-store')
    .send(csv);
}

const stamp = () => new Date().toISOString().slice(0, 10);

export async function auditRoutes(app: FastifyInstance) {
  app.get('/projects/:projectId/audit-logs/export', async (req, reply) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const q = parse(filters, req.query);
    const access = await requireProject(pool, u.id, projectId, 'audit.view');
    const { data } = await listAudit({ column: 'project_id', id: projectId }, { ...q, cursor: undefined }, EXPORT_MAX);
    await audit(pool, req, { tenantId: access.tenantId, projectId, actorUserId: u.id, action: 'audit.exported', targetType: 'project', targetId: projectId, metadata: { rows: data.length } });
    return sendCsv(reply, `activity-${stamp()}.csv`, data);
  });

  app.get('/tenants/:tenantId/audit-logs/export', async (req, reply) => {
    const u = requireUser(req);
    const { tenantId } = parse(z.object({ tenantId: uuid }), req.params);
    const q = parse(filters, req.query);
    await requireTenant(pool, u.id, tenantId, 'tenant.view_audit');
    const { data } = await listAudit({ column: 'tenant_id', id: tenantId, tenantLevelOnly: true }, { ...q, cursor: undefined }, EXPORT_MAX);
    await audit(pool, req, { tenantId, actorUserId: u.id, action: 'audit.exported', targetType: 'tenant', targetId: tenantId, metadata: { rows: data.length } });
    return sendCsv(reply, `audit-log-${stamp()}.csv`, data);
  });

  app.get('/projects/:projectId/audit-logs', async (req) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const q = parse(filters, req.query);
    await requireProject(pool, u.id, projectId, 'audit.view');
    return listAudit({ column: 'project_id', id: projectId }, q);
  });

  // Tenant admins see tenant-level events only — not project content activity (FR-011).
  app.get('/tenants/:tenantId/audit-logs', async (req) => {
    const u = requireUser(req);
    const { tenantId } = parse(z.object({ tenantId: uuid }), req.params);
    const q = parse(filters, req.query);
    await requireTenant(pool, u.id, tenantId, 'tenant.view_audit');
    return listAudit({ column: 'tenant_id', id: tenantId, tenantLevelOnly: true }, q);
  });
}
