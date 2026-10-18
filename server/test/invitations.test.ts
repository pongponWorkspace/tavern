// AC-006 invitation expiry/revocation and AC-007 replay & concurrency.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  count,
  createUser,
  get,
  login,
  one,
  pool,
  post,
  query,
  seedProject,
  useTestApp,
  type Seed,
  type Session,
} from './helpers.js';

useTestApp();

let s: Seed;
let admin: Session;

beforeEach(async () => {
  s = await seedProject('Alpha');
  admin = await login(s.users.admin.email);
});

async function invite(body: Record<string, unknown> = {}) {
  const res = await post(admin, `/api/v1/projects/${s.projectId}/invitations`, { role: 'viewer', ...body });
  expect(res.status, res.text).toBe(201);
  const token = new URL(res.body.url).pathname.split('/').pop()!;
  expect(token.length).toBeGreaterThanOrEqual(40);
  return { id: res.body.invitation.id as string, token, body: res.body };
}

async function newcomer(email?: string, opts: { verified?: boolean } = {}) {
  const u = await createUser({ email, verified: opts.verified });
  return { user: u, session: await login(u.email) };
}

const accept = (as: Session | null, token: string) => post(as, '/api/v1/invitations/accept', { token });

async function membership(userId: string) {
  return {
    project: await one(pool, 'SELECT role, status FROM project_memberships WHERE project_id = $1 AND user_id = $2', [s.projectId, userId]),
    tenant: await one(pool, 'SELECT role, status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [s.tenantId, userId]),
  };
}

describe('happy path', () => {
  it('a new user accepts a project invitation and gets the project role plus tenant membership', async () => {
    const inv = await invite({ role: 'maintainer' });
    const preview = await get(null, `/api/v1/invitations/preview?token=${inv.token}`);
    expect(preview.body).toMatchObject({ valid: true, projectName: 'Alpha Project', role: 'maintainer' });

    const { user, session } = await newcomer();
    const res = await accept(session, inv.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, tenantId: s.tenantId, projectId: s.projectId, alreadyMember: false });
    expect(await membership(user.id)).toEqual({ project: { role: 'maintainer', status: 'active' }, tenant: { role: 'member', status: 'active' } });
    expect(await one(pool, 'SELECT use_count, status FROM invitations WHERE id = $1', [inv.id])).toEqual({ use_count: 1, status: 'accepted' });
    expect((await get(session, `/api/v1/projects/${s.projectId}`)).status).toBe(200);
  });

  it('accept requires a signed-in user', async () => {
    const inv = await invite();
    const res = await accept(null, inv.token);
    expect(res.status).toBe(401);
    expect(await one(pool, 'SELECT use_count FROM invitations WHERE id = $1', [inv.id])).toEqual({ use_count: 0 });
  });

  it('only project admins can create, list or revoke project invitations', async () => {
    const inv = await invite();
    for (const key of ['maintainer', 'member', 'viewer'] as const) {
      const u = await login(s.users[key].email);
      expect((await post(u, `/api/v1/projects/${s.projectId}/invitations`, { role: 'project_admin' })).status).toBe(403);
      const list = await get(u, `/api/v1/projects/${s.projectId}/invitations`);
      expect(list.status).toBe(403);
      expect((await post(u, `/api/v1/invitations/${inv.id}/revoke`)).status).toBe(404);
    }
    const owner = await login(s.users.owner.email);
    expect((await post(owner, `/api/v1/projects/${s.projectId}/invitations`, { role: 'viewer' })).status).toBe(404);
    expect(await one(pool, 'SELECT status FROM invitations WHERE id = $1', [inv.id])).toEqual({ status: 'active' });
    expect(await count('SELECT count(*) FROM invitations')).toBe(1);
  });

  it('only the tenant owner can invite tenant admins', async () => {
    const tAdmin = await login(s.users.tenantAdmin.email);
    expect((await post(tAdmin, `/api/v1/tenants/${s.tenantId}/invitations`, { role: 'admin' })).status).toBe(403);
    expect((await post(tAdmin, `/api/v1/tenants/${s.tenantId}/invitations`, { role: 'member' })).status).toBe(201);
    const owner = await login(s.users.owner.email);
    expect((await post(owner, `/api/v1/tenants/${s.tenantId}/invitations`, { role: 'admin' })).status).toBe(201);
    const plain = await login(s.users.outsider.email);
    expect((await post(plain, `/api/v1/tenants/${s.tenantId}/invitations`, { role: 'member' })).status).toBe(403);
  });
});

describe('AC-006 expired / revoked / invalid invitations', () => {
  it('expired invitation → 410 INVITATION_INVALID, no membership, status becomes expired', async () => {
    const inv = await invite();
    await query(pool, `UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [inv.id]);
    expect((await get(null, `/api/v1/invitations/preview?token=${inv.token}`)).body.valid).toBe(false);

    const { user, session } = await newcomer();
    const res = await accept(session, inv.token);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('INVITATION_INVALID');
    expect(res.body.error.message).toMatch(/expired/i);
    expect(await membership(user.id)).toEqual({ project: undefined, tenant: undefined });
    expect(await one(pool, 'SELECT status, use_count FROM invitations WHERE id = $1', [inv.id])).toEqual({ status: 'expired', use_count: 0 });
    // The denial is audited.
    expect(await one(pool, `SELECT outcome, metadata_json FROM audit_logs WHERE action = 'invitation.accept'`)).toEqual({
      outcome: 'denied', metadata_json: { reason: 'expired' },
    });
  });

  it('revoked invitation → 410, no membership', async () => {
    const inv = await invite();
    const rev = await post(admin, `/api/v1/invitations/${inv.id}/revoke`);
    expect(rev.status).toBe(200);
    expect((await get(null, `/api/v1/invitations/preview?token=${inv.token}`)).body.valid).toBe(false);
    const { user, session } = await newcomer();
    const res = await accept(session, inv.token);
    expect(res.status).toBe(410);
    expect(res.body.error).toMatchObject({ code: 'INVITATION_INVALID' });
    expect(res.body.error.message).toMatch(/revoked/i);
    expect(await membership(user.id)).toEqual({ project: undefined, tenant: undefined });
  });

  it('unknown token → 410 with the generic message', async () => {
    const { session } = await newcomer();
    const res = await accept(session, 'x'.repeat(43));
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('INVITATION_INVALID');
    expect((await get(null, `/api/v1/invitations/preview?token=${'x'.repeat(43)}`)).body).toEqual({ valid: false, message: expect.any(String) });
  });

  it('invitation to an archived project → 410, no membership', async () => {
    const inv = await invite();
    await query(pool, `UPDATE projects SET status = 'archived' WHERE id = $1`, [s.projectId]);
    const { user, session } = await newcomer();
    const res = await accept(session, inv.token);
    expect(res.status).toBe(410);
    expect(await membership(user.id)).toEqual({ project: undefined, tenant: undefined });
    expect(await one(pool, 'SELECT use_count FROM invitations WHERE id = $1', [inv.id])).toEqual({ use_count: 0 });
  });

  it('email-restricted invitation cannot be used by someone else (or unverified)', async () => {
    const inv = await invite({ email: 'intended@example.test', maxUses: 5 });
    expect(inv.body.invitation.maxUses).toBe(1);
    const other = await newcomer('someone-else@example.test');
    const res = await accept(other.session, inv.token);
    expect(res.status).toBe(403);
    expect(await membership(other.user.id)).toEqual({ project: undefined, tenant: undefined });

    const unverified = await newcomer('intended@example.test', { verified: false });
    expect((await accept(unverified.session, inv.token)).status).toBe(403);
    await query(pool, 'UPDATE users SET email_verified_at = now() WHERE id = $1', [unverified.user.id]);
    expect((await accept(unverified.session, inv.token)).status).toBe(200);
  });

  it('domain-restricted invitation only admits matching verified addresses', async () => {
    const inv = await invite({ allowedDomain: 'partner.test', maxUses: 3 });
    const wrong = await newcomer('a@evil.test');
    expect((await accept(wrong.session, inv.token)).status).toBe(403);
    const right = await newcomer('b@partner.test');
    expect((await accept(right.session, inv.token)).status).toBe(200);
  });

  it('existing members are not downgraded or duplicated by an invitation', async () => {
    const inv = await invite({ role: 'viewer' });
    const maint = await login(s.users.maintainer.email);
    const res = await accept(maint, inv.token);
    expect(res.status).toBe(200);
    expect(res.body.alreadyMember).toBe(true);
    expect(await membership(s.users.maintainer.id)).toMatchObject({ project: { role: 'maintainer' } });
    expect(await one(pool, 'SELECT use_count FROM invitations WHERE id = $1', [inv.id])).toEqual({ use_count: 0 });
  });
});

describe('AC-007 replay and concurrency', () => {
  it('N concurrent different users on a max_uses=2 invite → exactly 2 succeed', async () => {
    const inv = await invite({ maxUses: 2 });
    const people = [];
    for (let i = 0; i < 6; i++) people.push(await newcomer());
    const results = await Promise.all(people.map((p) => accept(p.session, inv.token)));
    const ok = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status !== 200);
    expect(ok).toHaveLength(2);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.status).toBe(410);
      expect(r.body.error.code).toBe('INVITATION_INVALID');
    }
    expect(await one(pool, 'SELECT use_count, status FROM invitations WHERE id = $1', [inv.id])).toEqual({ use_count: 2, status: 'exhausted' });
    const ids = people.map((p) => p.user.id);
    expect(await count('SELECT count(*) FROM project_memberships WHERE project_id = $1 AND user_id = ANY($2::uuid[])', [s.projectId, ids])).toBe(2);
    expect(await count('SELECT count(*) FROM tenant_memberships WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])', [s.tenantId, ids])).toBe(2);
    expect(await count('SELECT count(*) FROM invitation_acceptances WHERE invitation_id = $1', [inv.id])).toBe(2);
  });

  it('single-use invite: second person is rejected', async () => {
    const inv = await invite();
    const a = await newcomer();
    const b = await newcomer();
    expect((await accept(a.session, inv.token)).status).toBe(200);
    const res = await accept(b.session, inv.token);
    expect(res.status).toBe(410);
    expect(await membership(b.user.id)).toEqual({ project: undefined, tenant: undefined });
  });

  it('same user accepting twice is idempotent — one membership row', async () => {
    const inv = await invite({ maxUses: 5 });
    const { user, session } = await newcomer();
    const first = await accept(session, inv.token);
    const second = await accept(session, inv.token);
    expect(first.body.alreadyMember).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.alreadyMember).toBe(true);
    expect(await count('SELECT count(*) FROM project_memberships WHERE user_id = $1', [user.id])).toBe(1);
    expect(await count('SELECT count(*) FROM tenant_memberships WHERE user_id = $1', [user.id])).toBe(1);
    expect(await one(pool, 'SELECT use_count FROM invitations WHERE id = $1', [inv.id])).toEqual({ use_count: 1 });
  });

  it('same user accepting concurrently is idempotent — one membership row, one use', async () => {
    const inv = await invite({ maxUses: 5 });
    const { user, session } = await newcomer();
    const results = await Promise.all([accept(session, inv.token), accept(session, inv.token), accept(session, inv.token)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.filter((r) => r.body.alreadyMember === false)).toHaveLength(1);
    expect(await count('SELECT count(*) FROM project_memberships WHERE user_id = $1', [user.id])).toBe(1);
    expect(await one(pool, 'SELECT use_count FROM invitations WHERE id = $1', [inv.id])).toEqual({ use_count: 1 });
  });

  it('same user re-accepting a used single-use invite stays idempotent', async () => {
    const inv = await invite();
    const { session } = await newcomer();
    expect((await accept(session, inv.token)).status).toBe(200);
    const again = await accept(session, inv.token);
    expect(again.status).toBe(200);
    expect(again.body.alreadyMember).toBe(true);
  });
});

describe('token secrecy', () => {
  it('the raw token is never stored or audited', async () => {
    const inv = await invite({ maxUses: 3 });
    const tenantInv = await post(await login(s.users.owner.email), `/api/v1/tenants/${s.tenantId}/invitations`, { role: 'member' });
    expect(tenantInv.status).toBe(201);
    const tenantToken = new URL(tenantInv.body.url).pathname.split('/').pop()!;
    const { session } = await newcomer();
    expect((await accept(session, inv.token)).status).toBe(200);
    await post(admin, `/api/v1/invitations/${inv.id}/revoke`);

    // No invitation column holds the raw token (only its SHA-256).
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'invitations'`)).rows.map((r) => r.column_name);
    expect(cols).toContain('token_hash');
    expect(cols).not.toContain('token');
    const invRows = JSON.stringify((await pool.query('SELECT * FROM invitations')).rows);
    for (const t of [inv.token, tenantToken]) {
      expect(invRows).not.toContain(t);
      const audit = JSON.stringify((await pool.query('SELECT * FROM audit_logs')).rows);
      expect(audit).not.toContain(t);
    }
    // The list endpoint never re-exposes the link.
    const list = await get(admin, `/api/v1/projects/${s.projectId}/invitations`);
    expect(list.text).not.toContain(inv.token);
    expect(list.body.data[0]).not.toHaveProperty('url');
    expect(await count(`SELECT count(*) FROM audit_logs WHERE action = 'invitation.created'`)).toBe(2);
  });
});
