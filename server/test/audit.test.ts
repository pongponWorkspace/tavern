// AC-012 audit log: security-relevant changes are recorded with actor,
// target, action, timestamp and outcome, never secrets; the table is append-only.
import { beforeEach, describe, expect, it } from 'vitest';
import { createItem, get, loginAll, patch, pool, post, put, seedProject, useTestApp, type Seed, PASSWORD } from './helpers.js';

useTestApp();

let s: Seed;
let as: Awaited<ReturnType<typeof loginAll>>;

beforeEach(async () => {
  s = await seedProject('Alpha');
  as = await loginAll(s.users);
});

async function auditRows(action: string) {
  return (await pool.query(`SELECT * FROM audit_logs WHERE action = $1 ORDER BY created_at`, [action])).rows;
}

function expectNoSecrets(rows: unknown[]) {
  const text = JSON.stringify(rows);
  const sessions = Object.values(as);
  for (const sess of sessions) {
    expect(text).not.toContain(sess.cookie.split('=')[1]);
    expect(text).not.toContain(sess.csrf);
  }
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toMatch(/\$argon2/);
  expect(text).not.toMatch(/"(token|password|secret|cookie|sig|signature)"/i);
}

describe('AC-012 audit events', () => {
  it('project role change records actor, target, action, outcome, timestamp and roles', async () => {
    const res = await patch(as.admin, `/api/v1/projects/${s.projectId}/members/${s.users.viewer.id}`, { role: 'maintainer' });
    expect(res.status).toBe(200);
    const [row] = await auditRows('project.member_role_changed');
    expect(row).toMatchObject({
      tenant_id: s.tenantId,
      project_id: s.projectId,
      actor_user_id: s.users.admin.id,
      target_type: 'user',
      target_id: s.users.viewer.id,
      outcome: 'success',
      metadata_json: { fromRole: 'viewer', toRole: 'maintainer' },
    });
    expect(new Date(row.created_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row.request_id).toMatch(/^req_/);
    expect(row.ip_hash).not.toBe('127.0.0.1');
    expectNoSecrets([row]);
  });

  it('item access-rule change records the new role lists', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'Sensitive' });
    const res = await patch(as.admin, `/api/v1/knowledge/${item.id}`, { version: 1, visibilityRoles: ['project_admin', 'maintainer'] });
    expect(res.status).toBe(200);
    const [row] = await auditRows('knowledge.access_changed');
    expect(row).toMatchObject({
      project_id: s.projectId,
      actor_user_id: s.users.admin.id,
      target_type: 'knowledge_item',
      target_id: item.id,
      outcome: 'success',
      metadata_json: {
        visibilityRoles: ['project_admin', 'maintainer'],
        editRoles: ['project_admin', 'maintainer'],
        archiveRoles: ['project_admin', 'maintainer'],
      },
    });
    expectNoSecrets([row]);
  });

  it('member removal, policy change, tenant role change and suspension are audited', async () => {
    await post(as.admin, `/api/v1/projects/${s.projectId}/members`, { email: s.users.outsider.email, role: 'viewer' });
    await put(as.admin, `/api/v1/projects/${s.projectId}/role-permissions`, { permissions: { member: { edit: 'all' } } });
    await patch(as.owner, `/api/v1/tenants/${s.tenantId}/members/${s.users.member.id}`, { role: 'admin' });
    await patch(as.owner, `/api/v1/tenants/${s.tenantId}/members/${s.users.viewer.id}`, { status: 'suspended' });
    expect((await auditRows('project.member_added'))[0]).toMatchObject({ actor_user_id: s.users.admin.id, target_id: s.users.outsider.id, metadata_json: { role: 'viewer' } });
    expect((await auditRows('project.permissions_changed'))[0]).toMatchObject({ actor_user_id: s.users.admin.id, target_id: s.projectId, metadata_json: { changes: ['member.edit: own → all'] } });
    expect((await auditRows('tenant.member_role_changed'))[0]).toMatchObject({
      tenant_id: s.tenantId, project_id: null, actor_user_id: s.users.owner.id, target_id: s.users.member.id, metadata_json: { fromRole: 'member', toRole: 'admin' },
    });
    expect((await auditRows('tenant.member_suspended'))[0]).toMatchObject({ actor_user_id: s.users.owner.id, target_id: s.users.viewer.id });
    expectNoSecrets((await pool.query('SELECT * FROM audit_logs')).rows);
  });

  it('failed logins are audited as denied without the attempted password', async () => {
    const res = await post(null, '/api/v1/auth/login', { email: s.users.member.email, password: 'wrong-password-123' });
    expect(res.status).toBe(401);
    const rows = (await pool.query(`SELECT * FROM audit_logs WHERE action = 'auth.login' AND outcome = 'denied'`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(s.users.member.id);
    expect(JSON.stringify(rows)).not.toContain('wrong-password-123');
  });

  it('project audit log is visible to the project admin only; tenant log excludes project events', async () => {
    await patch(as.admin, `/api/v1/projects/${s.projectId}/members/${s.users.viewer.id}`, { role: 'member' });
    const list = await get(as.admin, `/api/v1/projects/${s.projectId}/audit-logs`);
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({
      action: 'project.member_role_changed', outcome: 'success', targetId: s.users.viewer.id,
      actor: { id: s.users.admin.id }, targetLabel: 'Alpha viewer',
    });
    for (const key of ['maintainer', 'member', 'viewer'] as const) {
      expect((await get(as[key], `/api/v1/projects/${s.projectId}/audit-logs`)).status).toBe(403);
    }
    expect((await get(as.owner, `/api/v1/projects/${s.projectId}/audit-logs`)).status).toBe(404);
    const tenantLog = await get(as.owner, `/api/v1/tenants/${s.tenantId}/audit-logs`);
    expect(tenantLog.status).toBe(200);
    expect(tenantLog.body.data.some((r: any) => r.action === 'project.member_role_changed')).toBe(false);
    expect((await get(as.outsider, `/api/v1/tenants/${s.tenantId}/audit-logs`)).status).toBe(403);
  });
});

describe('audit_logs is append-only', () => {
  it('UPDATE and DELETE are rejected by the trigger', async () => {
    await patch(as.admin, `/api/v1/projects/${s.projectId}/members/${s.users.viewer.id}`, { role: 'member' });
    const before = (await pool.query('SELECT * FROM audit_logs ORDER BY id')).rows;
    expect(before.length).toBeGreaterThan(0);
    await expect(pool.query(`UPDATE audit_logs SET outcome = 'failure'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`UPDATE audit_logs SET metadata_json = '{}'::jsonb WHERE action = 'project.member_role_changed'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    expect((await pool.query('SELECT * FROM audit_logs ORDER BY id')).rows).toEqual(before);
  });
});
