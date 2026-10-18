// Shared integration-test harness: one Fastify app per test file (driven with
// app.inject), a clean database before every test, fast SQL factories, and a
// login helper that goes through the real /auth/login endpoint.
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { one, pool, query } from '../src/db/pool.js';
import { waitForScans } from '../src/modules/files.js';
import { permissionsFromPolicy, type ItemRules, type ProjectPolicy, type ProjectRole, type TenantRole } from '../src/authz/policy.js';

export { pool, one, query, waitForScans };

export const PASSWORD = 'Test-password-123';
export const APP_ORIGIN = 'http://localhost:5173';

let hashed: Promise<string> | null = null;
const passwordHash = () => (hashed ??= hash(PASSWORD));

let app: FastifyInstance;
export const getApp = () => app;

/** Register the per-file lifecycle: build app, truncate before each test, close at the end. */
export function useTestApp() {
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  beforeEach(async () => {
    await waitForScans();
    await resetDb();
  });
  afterAll(async () => {
    await waitForScans();
    await app?.close();
    await pool.end();
  });
}

export async function resetDb() {
  await pool.query('TRUNCATE users, tenants, email_outbox, audit_logs RESTART IDENTITY CASCADE');
}

// ───────────────────────── HTTP ─────────────────────────

export interface Session {
  userId: string;
  email: string;
  cookie: string;
  csrf: string;
}

export interface Res {
  status: number;
  body: any;
  text: string;
  headers: Record<string, any>;
  rawPayload: Buffer;
  cookies: { name: string; value: string; [k: string]: unknown }[];
}

export interface CallOpts {
  as?: Session | null;
  body?: unknown;
  headers?: Record<string, string>;
  /** Override the CSRF header; `null` omits it. Defaults to the session's token. */
  csrf?: string | null;
  rawBody?: Buffer;
}

export async function call(method: string, url: string, opts: CallOpts = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.as) {
    headers.cookie = opts.as.cookie;
    const csrf = opts.csrf === undefined ? opts.as.csrf : opts.csrf;
    if (csrf !== null) headers['x-csrf-token'] = csrf;
  }
  Object.assign(headers, opts.headers ?? {});
  const res = await app.inject({
    method: method as any,
    url,
    headers,
    ...(opts.rawBody !== undefined ? { payload: opts.rawBody } : opts.body !== undefined ? { payload: opts.body as any } : {}),
  });
  let body: any = undefined;
  try {
    body = res.json();
  } catch {
    body = undefined;
  }
  return { status: res.statusCode, body, text: res.body, headers: res.headers, rawPayload: res.rawPayload, cookies: res.cookies as any };
}

export const get = (as: Session | null, url: string, opts: Omit<CallOpts, 'as'> = {}) => call('GET', url, { ...opts, as });
export const post = (as: Session | null, url: string, body?: unknown, opts: Omit<CallOpts, 'as' | 'body'> = {}) =>
  call('POST', url, { ...opts, as, body });
export const patch = (as: Session | null, url: string, body?: unknown, opts: Omit<CallOpts, 'as' | 'body'> = {}) =>
  call('PATCH', url, { ...opts, as, body });
export const put = (as: Session | null, url: string, body?: unknown, opts: Omit<CallOpts, 'as' | 'body'> = {}) =>
  call('PUT', url, { ...opts, as, body });
export const del = (as: Session | null, url: string, opts: Omit<CallOpts, 'as'> = {}) => call('DELETE', url, { ...opts, as });

/** Sign in through the real endpoint and return the session cookie + CSRF token. */
export async function login(email: string, password = PASSWORD): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  const sid = res.cookies.find((c) => c.name === 'tavern_sid');
  if (!sid) throw new Error('login did not set a session cookie');
  const user = await one(pool, 'SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  return { userId: user.id, email, cookie: `tavern_sid=${sid.value}`, csrf: res.json().csrfToken };
}

// ───────────────────────── Factories (direct SQL) ─────────────────────────

let seq = 0;
const next = () => ++seq;

export interface TestUser {
  id: string;
  email: string;
  name: string;
}

export async function createUser(opts: { email?: string; name?: string; verified?: boolean; status?: string } = {}): Promise<TestUser> {
  const n = next();
  const email = (opts.email ?? `user${n}@example.test`).toLowerCase();
  const row = await one(
    pool,
    `INSERT INTO users (email, display_name, password_hash, email_verified_at, status)
     VALUES ($1,$2,$3, CASE WHEN $4 THEN now() END, $5) RETURNING id, email, display_name`,
    [email, opts.name ?? `User ${n}`, await passwordHash(), opts.verified ?? true, opts.status ?? 'active'],
  );
  return { id: row.id, email: row.email, name: row.display_name };
}

export async function createTenant(ownerId: string, name = 'Tenant'): Promise<{ id: string; name: string }> {
  const n = next();
  const row = await one(pool, `INSERT INTO tenants (name, slug, created_by) VALUES ($1,$2,$3) RETURNING id, name`, [
    name,
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${n}`,
    ownerId,
  ]);
  await addTenantMember(row.id, ownerId, 'owner');
  return { id: row.id, name: row.name };
}

export async function addTenantMember(tenantId: string, userId: string, role: TenantRole = 'member', status = 'active') {
  await query(pool, `INSERT INTO tenant_memberships (tenant_id, user_id, role, status) VALUES ($1,$2,$3,$4)`, [tenantId, userId, role, status]);
}

export async function createWorkspace(tenantId: string, createdBy: string, name = 'Workspace'): Promise<{ id: string; name: string }> {
  const n = next();
  const row = await one(pool, `INSERT INTO workspaces (tenant_id, name, slug, created_by) VALUES ($1,$2,$3,$4) RETURNING id, name`, [
    tenantId,
    name,
    `ws-${n}`,
    createdBy,
  ]);
  return { id: row.id, name: row.name };
}

export async function createProject(
  tenantId: string,
  workspaceId: string,
  createdBy: string,
  opts: { name?: string; policy?: Partial<ProjectPolicy>; status?: 'active' | 'archived' } = {},
): Promise<{ id: string; name: string }> {
  const n = next();
  const row = await one(
    pool,
    `INSERT INTO projects (tenant_id, workspace_id, name, slug, created_by, owner_user_id, status, role_permissions)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7) RETURNING id, name`,
    [tenantId, workspaceId, opts.name ?? `Project ${n}`, `p-${n}`, createdBy, opts.status ?? 'active', JSON.stringify(permissionsFromPolicy(opts.policy ?? {}))],
  );
  return { id: row.id, name: row.name };
}

/** Set a project's role matrix from the legacy four-switch policy shape (unspecified switches use defaults). */
export async function setPolicy(projectId: string, p: Partial<ProjectPolicy>) {
  await query(pool, `UPDATE projects SET role_permissions = $2 WHERE id = $1`, [projectId, JSON.stringify(permissionsFromPolicy(p))]);
}

export async function addProjectMember(tenantId: string, projectId: string, userId: string, role: ProjectRole) {
  await query(pool, `INSERT INTO project_memberships (tenant_id, project_id, user_id, role) VALUES ($1,$2,$3,$4)`, [tenantId, projectId, userId, role]);
}

export interface Scope {
  tenantId: string;
  projectId: string;
}

export async function createCategory(scope: Scope, name: string): Promise<{ id: string; name: string }> {
  const n = next();
  const row = await one(
    pool,
    `INSERT INTO knowledge_categories (tenant_id, project_id, name, slug) VALUES ($1,$2,$3,$4) RETURNING id, name`,
    [scope.tenantId, scope.projectId, name, `cat-${n}`],
  );
  return { id: row.id, name: row.name };
}

export async function createFile(
  scope: Scope,
  uploadedBy: string,
  opts: { name?: string; scanStatus?: 'pending' | 'clean' | 'quarantined' | 'failed'; uploadState?: string; size?: number } = {},
): Promise<{ id: string }> {
  const row = await one(
    pool,
    `INSERT INTO files (tenant_id, project_id, storage_key, original_filename, safe_filename, declared_mime, mime_type, size_bytes,
                        upload_state, scan_status, uploaded_by)
     VALUES ($1,$2,$8, $3, $3, 'application/pdf', 'application/pdf', $4, $5, $6, $7)
     RETURNING id`,
    [scope.tenantId, scope.projectId, opts.name ?? 'file.pdf', opts.size ?? 10, opts.uploadState ?? 'completed', opts.scanStatus ?? 'clean', uploadedBy,
     `tenants/${scope.tenantId}/projects/${scope.projectId}/${randomUUID()}`],
  );
  return { id: row.id };
}

export interface ItemOpts {
  type?: 'external_link' | 'uploaded_file' | 'internal_document';
  title?: string;
  description?: string;
  url?: string;
  content?: string;
  fileId?: string;
  status?: 'active' | 'archived';
  isPinned?: boolean;
  categoryId?: string | null;
  tags?: string[];
  rules?: ItemRules;
}

export async function createItem(scope: Scope, createdBy: string, opts: ItemOpts = {}): Promise<{ id: string; title: string }> {
  const n = next();
  const type = opts.type ?? (opts.fileId ? 'uploaded_file' : 'external_link');
  const url = type === 'external_link' ? (opts.url ?? `https://example.com/doc-${n}`) : null;
  const row = await one(
    pool,
    `INSERT INTO knowledge_items (tenant_id, project_id, category_id, type, title, description, external_url, normalized_url, file_id,
                                  owner_user_id, created_by, updated_by, is_pinned, status, archived_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10,$11,$12, CASE WHEN $12 = 'archived' THEN now() END) RETURNING id, title`,
    [scope.tenantId, scope.projectId, opts.categoryId ?? null, type, opts.title ?? `Item ${n}`, opts.description ?? '',
     url, url ? url.replace(/^https?:\/\//, '') : null, type === 'uploaded_file' ? opts.fileId : null,
     createdBy, opts.isPinned ?? false, opts.status ?? 'active'],
  );
  if (type === 'internal_document') {
    await query(pool, `INSERT INTO knowledge_documents (knowledge_item_id, tenant_id, project_id, content_md, updated_by) VALUES ($1,$2,$3,$4,$5)`, [
      row.id, scope.tenantId, scope.projectId, opts.content ?? '', createdBy,
    ]);
  }
  for (const tag of opts.tags ?? []) {
    const slug = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const t = await one(
      pool,
      `INSERT INTO knowledge_tags (tenant_id, project_id, name, slug) VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, slug) DO UPDATE SET name = knowledge_tags.name RETURNING id`,
      [scope.tenantId, scope.projectId, tag, slug],
    );
    await query(pool, `INSERT INTO knowledge_item_tags (project_id, knowledge_item_id, tag_id) VALUES ($1,$2,$3)`, [scope.projectId, row.id, t.id]);
  }
  for (const [role, r] of Object.entries(opts.rules ?? {})) {
    if (!r) continue;
    await query(
      pool,
      `INSERT INTO knowledge_item_access_rules (tenant_id, project_id, knowledge_item_id, role, can_view, can_edit, can_archive, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [scope.tenantId, scope.projectId, row.id, role, r.canView, r.canEdit, r.canArchive, createdBy],
    );
  }
  return { id: row.id, title: row.title };
}

/** Narrowing rule that hides an item from a role entirely. */
export const HIDDEN = { canView: false, canEdit: false, canArchive: false };

// ───────────────────────── Scenario ─────────────────────────

export type SeedUsers = Record<'owner' | 'tenantAdmin' | 'outsider' | 'admin' | 'maintainer' | 'member' | 'viewer', TestUser>;

export interface Seed extends Scope {
  label: string;
  tenant: { id: string; name: string };
  workspace: { id: string; name: string };
  project: { id: string; name: string };
  users: SeedUsers;
}

/**
 * One tenant with one workspace and project. The tenant owner and a tenant
 * admin are NOT project members; `outsider` is a plain tenant member outside
 * the project; admin/maintainer/member/viewer hold the matching project role.
 */
export async function seedProject(label = 'Alpha', opts: { policy?: Partial<ProjectPolicy> } = {}): Promise<Seed> {
  const l = label.toLowerCase();
  const owner = await createUser({ email: `${l}-owner@example.test`, name: `${label} Owner` });
  const tenant = await createTenant(owner.id, `${label} Org`);
  const workspace = await createWorkspace(tenant.id, owner.id, `${label} Workspace`);
  const project = await createProject(tenant.id, workspace.id, owner.id, { name: `${label} Project`, policy: opts.policy });
  const users: Partial<SeedUsers> = { owner };

  const tenantAdmin = await createUser({ email: `${l}-tadmin@example.test`, name: `${label} Tenant Admin` });
  await addTenantMember(tenant.id, tenantAdmin.id, 'admin');
  users.tenantAdmin = tenantAdmin;
  const outsider = await createUser({ email: `${l}-outsider@example.test`, name: `${label} Outsider` });
  await addTenantMember(tenant.id, outsider.id, 'member');
  users.outsider = outsider;

  const roles: [keyof SeedUsers, ProjectRole][] = [
    ['admin', 'project_admin'],
    ['maintainer', 'maintainer'],
    ['member', 'member'],
    ['viewer', 'viewer'],
  ];
  for (const [key, role] of roles) {
    const u = await createUser({ email: `${l}-${key}@example.test`, name: `${label} ${key}` });
    await addTenantMember(tenant.id, u.id, 'member');
    await addProjectMember(tenant.id, project.id, u.id, role);
    users[key] = u;
  }
  return { label, tenant, workspace, project, users: users as SeedUsers, tenantId: tenant.id, projectId: project.id };
}

/** Log in every seeded user. */
export async function loginAll(users: SeedUsers): Promise<Record<keyof SeedUsers, Session>> {
  const out: Partial<Record<keyof SeedUsers, Session>> = {};
  for (const [k, u] of Object.entries(users)) out[k as keyof SeedUsers] = await login(u.email);
  return out as Record<keyof SeedUsers, Session>;
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await one(pool, sql, params);
  return Number(Object.values(r)[0]);
}
