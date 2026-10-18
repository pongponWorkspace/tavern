// Project membership management: AC-008 immediate revocation, last-admin
// protection, and role changes taking effect on the next request.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addProjectMember,
  count,
  createFile,
  createItem,
  del,
  get,
  loginAll,
  one,
  patch,
  pool,
  post,
  seedProject,
  useTestApp,
  type Seed,
  query,
} from './helpers.js';

useTestApp();

let s: Seed;
let as: Awaited<ReturnType<typeof loginAll>>;

beforeEach(async () => {
  s = await seedProject('Alpha');
  as = await loginAll(s.users);
});

const membersUrl = (userId?: string) => `/api/v1/projects/${s.projectId}/members${userId ? `/${userId}` : ''}`;

describe('AC-008 removed member loses access immediately', () => {
  it('existing session gets 404 for project, items, content and file URLs right after removal', async () => {
    const link = await createItem(s, s.users.admin.id, { title: 'Wombat link' });
    const doc = await createItem(s, s.users.admin.id, { type: 'internal_document', title: 'Wombat doc', content: 'Wombat body' });
    const file = await createFile(s, s.users.admin.id, { scanStatus: 'clean' });
    await createItem(s, s.users.admin.id, { type: 'uploaded_file', fileId: file.id, title: 'Wombat file' });

    const m = as.member;
    const urls = [
      `/api/v1/projects/${s.projectId}`,
      `/api/v1/projects/${s.projectId}/knowledge`,
      `/api/v1/projects/${s.projectId}/overview`,
      `/api/v1/projects/${s.projectId}/people`,
      `/api/v1/knowledge/${link.id}`,
      `/api/v1/knowledge/${doc.id}/content`,
      `/api/v1/files/${file.id}/download-url`,
    ];
    for (const url of urls) expect((await get(m, url)).status, url).toBe(200);

    const removed = await del(as.admin, membersUrl(s.users.member.id));
    expect(removed.status).toBe(200);

    for (const url of urls) {
      const res = await get(m, url);
      expect(res.status, url).toBe(404);
      expect(res.text.toLowerCase()).not.toContain('wombat');
    }
    expect((await patch(m, `/api/v1/knowledge/${link.id}`, { version: 1, title: 'x' })).status).toBe(404);
    expect((await post(m, `/api/v1/projects/${s.projectId}/knowledge`, { type: 'external_link', title: 'x', externalUrl: 'https://x.example' })).status).toBe(404);
    const dash = await get(m, `/api/v1/tenants/${s.tenantId}/dashboard`);
    expect(dash.body.projects).toEqual([]);
    expect(dash.text.toLowerCase()).not.toContain('wombat');
    expect((await get(m, `/api/v1/tenants/${s.tenantId}/search?q=Wombat`)).body.data).toEqual([]);
    // Same session is still valid for non-project APIs — this really is the old session.
    expect((await get(m, '/api/v1/me')).status).toBe(200);
    expect(await one(pool, 'SELECT status FROM project_memberships WHERE user_id = $1', [s.users.member.id])).toEqual({ status: 'removed' });
  });

  it('removal from the tenant also cuts project access', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'X' });
    expect((await get(as.viewer, `/api/v1/knowledge/${item.id}`)).status).toBe(200);
    expect((await del(as.owner, `/api/v1/tenants/${s.tenantId}/members/${s.users.viewer.id}`)).status).toBe(200);
    expect((await get(as.viewer, `/api/v1/knowledge/${item.id}`)).status).toBe(404);
    expect((await get(as.viewer, `/api/v1/tenants/${s.tenantId}`)).status).toBe(404);
    expect(await count('SELECT count(*) FROM project_memberships WHERE user_id = $1', [s.users.viewer.id])).toBe(0);
  });

  it('tenant suspension blocks project access with the same session', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'X' });
    expect((await patch(as.owner, `/api/v1/tenants/${s.tenantId}/members/${s.users.member.id}`, { status: 'suspended' })).status).toBe(200);
    expect((await get(as.member, `/api/v1/knowledge/${item.id}`)).status).toBe(404);
    expect((await get(as.member, `/api/v1/projects/${s.projectId}`)).status).toBe(404);
  });

  it('a re-added member regains access with their new role', async () => {
    await del(as.admin, membersUrl(s.users.member.id));
    const res = await post(as.admin, membersUrl(), { email: s.users.member.email, role: 'viewer' });
    expect(res.status).toBe(201);
    const p = await get(as.member, `/api/v1/projects/${s.projectId}`);
    expect(p.status).toBe(200);
    expect(p.body.myRole).toBe('viewer');
  });
});

describe('role changes', () => {
  it('demotion applies on the next request', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'X' });
    expect((await patch(as.admin, membersUrl(s.users.maintainer.id), { role: 'viewer' })).status).toBe(200);
    expect((await patch(as.maintainer, `/api/v1/knowledge/${item.id}`, { version: 1, title: 'y' })).status).toBe(403);
    expect((await get(as.maintainer, `/api/v1/projects/${s.projectId}`)).body.myRole).toBe('viewer');
  });

  it('only project admins can change roles; nobody can self-promote', async () => {
    for (const key of ['maintainer', 'member', 'viewer'] as const) {
      expect((await patch(as[key], membersUrl(s.users[key].id), { role: 'project_admin' })).status).toBe(403);
      expect((await del(as[key], membersUrl(s.users.admin.id))).status).toBe(403);
    }
    // Tenant owner/admin without project membership can't either (concealed).
    for (const key of ['owner', 'tenantAdmin'] as const) {
      expect((await patch(as[key], membersUrl(s.users.viewer.id), { role: 'project_admin' })).status).toBe(404);
    }
    const roles = (await pool.query('SELECT user_id, role FROM project_memberships ORDER BY role')).rows;
    expect(roles.filter((r) => r.role === 'project_admin').map((r) => r.user_id)).toEqual([s.users.admin.id]);
  });

  it('admin member list shows emails; people list (any member) does not', async () => {
    const full = await get(as.admin, membersUrl());
    expect(full.body.data.map((m: any) => m.email)).toContain(s.users.viewer.email);
    const people = await get(as.viewer, `/api/v1/projects/${s.projectId}/people`);
    expect(people.status).toBe(200);
    expect(people.text).not.toContain('@example.test');
  });
});

describe('last Project Admin protection', () => {
  it('the only Project Admin cannot be demoted or removed (409)', async () => {
    const demote = await patch(as.admin, membersUrl(s.users.admin.id), { role: 'maintainer' });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('CONFLICT');
    const remove = await del(as.admin, membersUrl(s.users.admin.id));
    expect(remove.status).toBe(409);
    expect(await one(pool, 'SELECT role, status FROM project_memberships WHERE user_id = $1', [s.users.admin.id])).toEqual({
      role: 'project_admin', status: 'active',
    });
    // Removing them from the tenant is blocked as well.
    const tenantRemove = await del(as.owner, `/api/v1/tenants/${s.tenantId}/members/${s.users.admin.id}`);
    expect(tenantRemove.status).toBe(409);
    expect(await count('SELECT count(*) FROM tenant_memberships WHERE user_id = $1', [s.users.admin.id])).toBe(1);
  });

  it('with a second admin, demotion works; the remaining admin is then protected', async () => {
    expect((await patch(as.admin, membersUrl(s.users.maintainer.id), { role: 'project_admin' })).status).toBe(200);
    expect((await patch(as.admin, membersUrl(s.users.admin.id), { role: 'member' })).status).toBe(200);
    expect((await del(as.maintainer, membersUrl(s.users.maintainer.id))).status).toBe(409);
    expect((await patch(as.maintainer, membersUrl(s.users.maintainer.id), { role: 'viewer' })).status).toBe(409);
  });

  it('two admins demoting each other concurrently cannot both succeed', async () => {
    await addProjectMember(s.tenantId, s.projectId, s.users.outsider.id, 'project_admin');
    const results = await Promise.all([
      patch(as.admin, membersUrl(s.users.outsider.id), { role: 'viewer' }),
      patch(as.outsider, membersUrl(s.users.admin.id), { role: 'viewer' }),
    ]);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(await count(`SELECT count(*) FROM project_memberships WHERE project_id = $1 AND role = 'project_admin' AND status = 'active'`, [s.projectId])).toBeGreaterThanOrEqual(1);
  });

  it('a removed admin row no longer counts as an admin', async () => {
    await addProjectMember(s.tenantId, s.projectId, s.users.outsider.id, 'project_admin');
    expect((await del(as.admin, membersUrl(s.users.outsider.id))).status).toBe(200);
    expect((await patch(as.admin, membersUrl(s.users.admin.id), { role: 'viewer' })).status).toBe(409);
  });
});

describe('add from organization (search and pick)', () => {
  const candidates = (q = '') => `/api/v1/projects/${s.projectId}/member-candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`;

  it('lists active organization members who are not on the project; admins only', async () => {
    const res = await get(as.admin, candidates());
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([s.users.owner.id, s.users.tenantAdmin.id, s.users.outsider.id]));
    for (const k of ['admin', 'maintainer', 'member', 'viewer'] as const) expect(ids).not.toContain(s.users[k].id);
    expect((await get(as.maintainer, candidates())).status).toBe(403);
    expect((await get(as.outsider, candidates())).status).toBe(404);
  });

  it('searches by name or email and never shows other organizations or suspended people', async () => {
    const other = await seedProject('Beta');
    await query(pool, `UPDATE tenant_memberships SET status = 'suspended' WHERE user_id = $1`, [s.users.tenantAdmin.id]);
    const byEmail = await get(as.admin, candidates('outsider'));
    expect(byEmail.body.data.map((c: { id: string }) => c.id)).toEqual([s.users.outsider.id]);
    const all = (await get(as.admin, candidates())).body.data.map((c: { id: string }) => c.id);
    expect(all).not.toContain(other.users.outsider.id);
    expect(all).not.toContain(s.users.tenantAdmin.id);
  });

  it('adds several picked people with one role, and rejects ids from another organization', async () => {
    const other = await seedProject('Gamma');
    const bad = await post(as.admin, `/api/v1/projects/${s.projectId}/members`, { userIds: [s.users.outsider.id, other.users.outsider.id], role: 'viewer' });
    expect(bad.status).toBe(404);
    expect(await count(`SELECT count(*) FROM project_memberships WHERE project_id = $1 AND user_id = $2`, [s.projectId, s.users.outsider.id])).toBe(0);

    const ok = await post(as.admin, `/api/v1/projects/${s.projectId}/members`, { userIds: [s.users.outsider.id, s.users.tenantAdmin.id], role: 'viewer' });
    expect(ok.status).toBe(201);
    expect(ok.body.added).toBe(2);
    const roles = await query(pool, `SELECT role FROM project_memberships WHERE project_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'active'`, [s.projectId, [s.users.outsider.id, s.users.tenantAdmin.id]]);
    expect(roles.map((r: { role: string }) => r.role)).toEqual(['viewer', 'viewer']);
    expect((await post(as.admin, `/api/v1/projects/${s.projectId}/members`, { userIds: [s.users.outsider.id], role: 'member' })).status).toBe(409);
  });
});
