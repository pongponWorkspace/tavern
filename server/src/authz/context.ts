// Request-scoped authorization loaders. Every project/tenant route resolves its
// access through these, so tenant scope, membership status and role are always
// re-read from the database on the request (role changes apply immediately, §3.2).

import type { FastifyRequest } from 'fastify';
import { one, type Db } from '../db/pool.js';
import { forbidden, notFound, readOnly, unauthenticated } from '../lib/errors.js';
import {
  projectCan,
  tenantCan,
  type ProjectAction,
  normalizeProjectPermissions,
  normalizeTenantPermissions,
  type ProjectPermissions,
  type TenantPermissions,
  type ProjectRole,
  type TenantAction,
  type TenantRole,
} from './policy.js';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  sessionId: string;
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}

export interface TenantAccess {
  tenantId: string;
  tenantName: string;
  role: TenantRole;
  /** This organization's role → capability matrix (normalized). */
  permissions: TenantPermissions;
}

/** Active member of an active tenant, else a concealing 404. */
export async function loadTenantAccess(db: Db, userId: string, tenantId: string): Promise<TenantAccess> {
  const row = await one<{ tenant_id: string; name: string; role: TenantRole; role_permissions: unknown }>(
    db,
    `SELECT t.id AS tenant_id, t.name, tm.role, t.role_permissions
       FROM tenants t
       JOIN tenant_memberships tm ON tm.tenant_id = t.id AND tm.user_id = $1 AND tm.status = 'active'
      WHERE t.id = $2 AND t.status = 'active'`,
    [userId, tenantId],
  );
  if (!row) throw notFound('organization');
  return { tenantId: row.tenant_id, tenantName: row.name, role: row.role, permissions: normalizeTenantPermissions(row.role_permissions) };
}

export async function requireTenant(db: Db, userId: string, tenantId: string, action: TenantAction) {
  const access = await loadTenantAccess(db, userId, tenantId);
  if (!tenantCan(access.role, action, access.permissions)) throw forbidden();
  return access;
}

export interface ProjectAccess {
  tenantId: string;
  projectId: string;
  workspaceId: string;
  projectName: string;
  role: ProjectRole;
  tenantRole: TenantRole;
  /** This project's role → capability matrix (normalized). */
  permissions: ProjectPermissions;
  /** false when the project, its workspace or tenant is archived/suspended. */
  writable: boolean;
  status: 'active' | 'archived';
}

/**
 * Resolve the caller's access to a project. Requires an active project
 * membership AND an active tenant membership in an active tenant. Tenant
 * owners/admins without a project membership get the same 404 as strangers.
 */
export async function loadProjectAccess(db: Db, userId: string, projectId: string): Promise<ProjectAccess> {
  const row = await one(
    db,
    `SELECT p.id, p.tenant_id, p.workspace_id, p.name, p.status, w.status AS workspace_status,
            pm.role, tm.role AS tenant_role,
            p.role_permissions
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id AND w.tenant_id = p.tenant_id
       JOIN tenants t ON t.id = p.tenant_id AND t.status = 'active'
       JOIN project_memberships pm ON pm.project_id = p.id AND pm.tenant_id = p.tenant_id
                                  AND pm.user_id = $1 AND pm.status = 'active'
       JOIN tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.user_id = $1 AND tm.status = 'active'
      WHERE p.id = $2`,
    [userId, projectId],
  );
  if (!row) throw notFound('project');
  return {
    tenantId: row.tenant_id,
    projectId: row.id,
    workspaceId: row.workspace_id,
    projectName: row.name,
    role: row.role,
    tenantRole: row.tenant_role,
    status: row.status,
    writable: row.status === 'active' && row.workspace_status === 'active',
    permissions: normalizeProjectPermissions(row.role_permissions),
  };
}

export function assertProjectCan(access: ProjectAccess, action: ProjectAction) {
  if (!projectCan(access.role, action, access.permissions)) throw forbidden();
}

export function assertWritable(access: ProjectAccess) {
  if (!access.writable) throw readOnly();
}

/** Load access, check the action, and (for mutations) require a writable project. */
export async function requireProject(
  db: Db,
  userId: string,
  projectId: string,
  action: ProjectAction,
  { write = false } = {},
): Promise<ProjectAccess> {
  const access = await loadProjectAccess(db, userId, projectId);
  assertProjectCan(access, action);
  if (write) assertWritable(access);
  return access;
}
