// Customizable RBAC tables: who may edit them, guard rails, and that the
// stored matrix actually drives authorization on the next request.
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeProjectPermissions, normalizeTenantPermissions } from '../src/authz/policy.js';
import { createItem, del, get, loginAll, one, patch, pool, post, put, seedProject, useTestApp, type Seed } from './helpers.js';

useTestApp();

let s: Seed;
let as: Awaited<ReturnType<typeof loginAll>>;

beforeEach(async () => {
  s = await seedProject('Rbac');
  as = await loginAll(s.users);
});

const projRoles = () => `/api/v1/projects/${s.projectId}/role-permissions`;
const orgRoles = () => `/api/v1/tenants/${s.tenantId}/role-permissions`;

describe('normalizers enforce guard rails', () => {
  it('viewers stay read-only whatever is sent', () => {
    const p = normalizeProjectPermissions({ viewer: { create: true, edit: 'all', archive: true, delete: true, pin: true, restrict: true, categories: true, onboarding: true, audit: true } });
    expect(p.viewer).toEqual({ create: false, edit: 'none', archive: false, delete: false, pin: false, restrict: false, categories: false, onboarding: false, audit: true });
  });
  it('delete implies archive; no edit right removes pin and restrict', () => {
    const p = normalizeProjectPermissions({ member: { delete: true, archive: false, edit: 'none', pin: true, restrict: true } });
    expect(p.member).toMatchObject({ delete: true, archive: true, pin: false, restrict: false });
  });
  it('org capabilities that need the settings page turn settings.view on', () => {
    const t = normalizeTenantPermissions({ member: { 'members.manage': true } });
    expect(t.member['settings.view']).toBe(true);
  });
  it('fills unknown or malformed input from defaults', () => {
    expect(normalizeProjectPermissions('nonsense').maintainer.edit).toBe('all');
    expect(normalizeTenantPermissions(null).admin['project.create']).toBe(true);
  });
});

describe('project RBAC table', () => {
  it('only Project Admins can change it; everyone in the project can read it', async () => {
    for (const who of ['maintainer', 'member', 'viewer'] as const) {
      expect((await put(as[who], projRoles(), { permissions: { member: { create: false } } })).status).toBe(403);
    }
    expect((await put(as.tenantAdmin, projRoles(), { permissions: { member: { create: false } } })).status).toBe(404);
    expect((await get(as.viewer, `/api/v1/projects/${s.projectId}`)).body.rolePermissions.member.create).toBe(true);
  });

  it('rejects unknown roles and capabilities', async () => {
    expect((await put(as.admin, projRoles(), { permissions: { project_admin: { create: false } } })).status).toBe(422);
    expect((await put(as.admin, projRoles(), { permissions: { member: { manageMembers: true } } })).status).toBe(422);
  });

  it('a granted capability applies on the next request', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'Old' });
    expect((await post(as.member, `/api/v1/knowledge/${item.id}/archive`)).status).toBe(403);
    const res = await put(as.admin, projRoles(), { permissions: { member: { archive: true, audit: true } } });
    expect(res.status).toBe(200);
    expect(res.body.rolePermissions.member).toMatchObject({ archive: true, audit: true });
    expect((await post(as.member, `/api/v1/knowledge/${item.id}/archive`)).status).toBe(200);
    expect((await get(as.member, `/api/v1/projects/${s.projectId}/audit-logs`)).status).toBe(200);
    expect((await get(as.member, `/api/v1/projects/${s.projectId}/knowledge?status=archived`)).body.page.total).toBe(1);
  });

  it('a revoked capability is denied on the next request', async () => {
    await put(as.admin, projRoles(), { permissions: { maintainer: { create: false, categories: false } } });
    expect((await post(as.maintainer, `/api/v1/projects/${s.projectId}/knowledge`, { type: 'external_link', title: 'x', externalUrl: 'https://example.com' })).status).toBe(403);
    expect((await post(as.maintainer, `/api/v1/projects/${s.projectId}/categories`, { name: 'Cat' })).status).toBe(403);
  });

  it('granting delete lets that role permanently delete archived items', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'Gone', status: 'archived' });
    expect((await put(as.admin, projRoles(), { permissions: { maintainer: { delete: true } } })).status).toBe(200);
    const res = await post(as.maintainer, `/api/v1/knowledge/${item.id}/restore`);
    expect(res.status).toBe(200);
    await post(as.maintainer, `/api/v1/knowledge/${item.id}/archive`);
    expect((await del(as.maintainer, `/api/v1/knowledge/${item.id}`)).status).toBe(200);
  });

  it('no setting lets another role manage members, invitations or the table itself', async () => {
    await put(as.admin, projRoles(), { permissions: { maintainer: { create: true, edit: 'all', archive: true, delete: true, pin: true, restrict: true, categories: true, onboarding: true, audit: true } } });
    expect((await post(as.maintainer, `/api/v1/projects/${s.projectId}/invitations`, { role: 'project_admin' })).status).toBe(403);
    expect((await patch(as.maintainer, `/api/v1/projects/${s.projectId}/members/${s.users.maintainer.id}`, { role: 'project_admin' })).status).toBe(403);
    expect((await put(as.maintainer, projRoles(), { permissions: { member: { create: false } } })).status).toBe(403);
  });

  it('viewer write capabilities are ignored even when sent', async () => {
    const res = await put(as.admin, projRoles(), { permissions: { viewer: { create: true, edit: 'all' } } });
    expect(res.status).toBe(200);
    expect(res.body.rolePermissions.viewer).toMatchObject({ create: false, edit: 'none' });
    expect((await post(as.viewer, `/api/v1/projects/${s.projectId}/knowledge`, { type: 'external_link', title: 'x', externalUrl: 'https://example.com' })).status).toBe(403);
  });

  it('changes are audited with a per-cell diff', async () => {
    await put(as.admin, projRoles(), { permissions: { member: { create: false } } });
    const row = await one(pool, `SELECT actor_user_id, metadata_json FROM audit_logs WHERE action = 'project.permissions_changed'`);
    expect(row).toMatchObject({ actor_user_id: s.users.admin.id, metadata_json: { changes: ['member.create: true → false'] } });
  });
});

describe('organization RBAC table', () => {
  it('only the owner can change it; every member can read it', async () => {
    expect((await put(as.tenantAdmin, orgRoles(), { permissions: { member: { 'workspace.create': true } } })).status).toBe(403);
    expect((await put(as.outsider, orgRoles(), { permissions: { member: { 'workspace.create': true } } })).status).toBe(403);
    const t = await get(as.tenantAdmin, `/api/v1/tenants/${s.tenantId}`);
    expect(t.body.rolePermissions.admin['project.create']).toBe(true);
    expect(t.body.permissions.manageRoles).toBe(false);
    // Plain members can read the table too, but not the organization settings.
    const asMember = (await get(as.outsider, `/api/v1/tenants/${s.tenantId}`)).body;
    expect(asMember.rolePermissions.member['project.create']).toBe(false);
    expect(asMember.settings).toBeUndefined();
  });

  it('grants and revocations apply on the next request', async () => {
    const ws = () => post(as.outsider, `/api/v1/tenants/${s.tenantId}/workspaces`, { name: 'Member space' });
    expect((await ws()).status).toBe(403);
    expect((await put(as.owner, orgRoles(), { permissions: { member: { 'workspace.create': true } } })).status).toBe(200);
    expect((await ws()).status).toBe(201);

    expect((await put(as.owner, orgRoles(), { permissions: { admin: { 'project.create': false } } })).status).toBe(200);
    expect((await post(as.tenantAdmin, `/api/v1/workspaces/${s.workspace.id}/projects`, { name: 'Nope' })).status).toBe(403);
  });

  it('a member granted "manage members" still cannot promote anyone to admin', async () => {
    await put(as.owner, orgRoles(), { permissions: { member: { 'members.manage': true } } });
    expect((await get(as.outsider, `/api/v1/tenants/${s.tenantId}/members`)).status).toBe(200);
    expect((await patch(as.outsider, `/api/v1/tenants/${s.tenantId}/members/${s.users.member.id}`, { role: 'admin' })).status).toBe(403);
    expect((await post(as.outsider, `/api/v1/tenants/${s.tenantId}/invitations`, { role: 'admin' })).status).toBe(403);
    expect((await patch(as.outsider, `/api/v1/tenants/${s.tenantId}/members/${s.users.member.id}`, { status: 'suspended' })).status).toBe(200);
  });

  it('owner-only actions cannot be delegated', async () => {
    const res = await put(as.owner, orgRoles(), { permissions: { admin: { 'tenant.transfer_ownership': true } } });
    expect(res.status).toBe(422);
  });
});
