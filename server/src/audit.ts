import type { FastifyRequest } from 'fastify';
import { query, type Db } from './db/pool.js';
import { hashIp } from './lib/crypto.js';

export interface AuditEvent {
  tenantId?: string | null;
  projectId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  outcome?: 'success' | 'denied' | 'failure';
  /** Allowlisted, non-sensitive fields only — never tokens, passwords, URLs with signatures or document bodies. */
  metadata?: Record<string, string | number | boolean | null | string[]>;
}

const FORBIDDEN_KEYS = /token|password|secret|signature|sig|content|cookie/i;

/** Write an audit row. Pass the transaction client so the event commits with the change (§9.8 step 6). */
export async function audit(db: Db, req: FastifyRequest | null, event: AuditEvent): Promise<void> {
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event.metadata ?? {})) {
    if (!FORBIDDEN_KEYS.test(k)) metadata[k] = v;
  }
  await query(
    db,
    `INSERT INTO audit_logs (tenant_id, project_id, actor_user_id, action, target_type, target_id, outcome, metadata_json, request_id, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      event.tenantId ?? null,
      event.projectId ?? null,
      event.actorUserId ?? null,
      event.action,
      event.targetType,
      event.targetId ?? null,
      event.outcome ?? 'success',
      JSON.stringify(metadata),
      req?.id ?? null,
      hashIp(req?.ip),
    ],
  );
}
