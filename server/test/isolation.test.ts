// AC-001 tenant isolation and AC-002 project membership (tenant roles do not
// imply project access).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HIDDEN,
  count,
  createCategory,
  createFile,
  createItem,
  del,
  get,
  login,
  loginAll,
  one,
  patch,
  pool,
  post,
  put,
  query,
  seedProject,
  useTestApp,
  type Res,
  type Seed,
  type Session,
} from './helpers.js';
import { sha256 } from '../src/lib/crypto.js';

useTestApp();

interface BravoData {
  seed: Seed;
  itemId: string;
  docId: string;
  fileId: string;
  categoryId: string;
  invitationId: string;
  tenantInvitationId: string;
  templateId: string;
  stepId: string;
}

/** Tenant B, filled with data whose names all contain "Bravo". */
async function seedBravo(): Promise<BravoData> {
  const seed = await seedProject('Bravo');
  const admin = seed.users.admin.id;
  const cat = await createCategory(seed, 'Bravo Category');
  const file = await createFile(seed, admin, { name: 'bravo-plan.pdf', scanStatus: 'clean' });
  const fileItem = await createItem(seed, admin, { type: 'uploaded_file', fileId: file.id, title: 'Bravo File Item' });
  void fileItem;
  const item = await createItem(seed, admin, { title: 'Bravo Link', description: 'Bravo description', categoryId: cat.id, tags: ['bravo-tag'], isPinned: true });
  const doc = await createItem(seed, admin, { type: 'internal_document', title: 'Bravo Doc', content: 'Bravo secret content' });
  const inv = await one(
    pool,
    `INSERT INTO invitations (tenant_id, project_id, token_hash, target_role, expires_at, created_by)
     VALUES ($1,$2,$3,'viewer', now() + interval '1 day', $4) RETURNING id`,
    [seed.tenantId, seed.projectId, sha256('bravo-project-token-xxxxxxxxxxxxxxx'), admin],
  );
  const tinv = await one(
    pool,
    `INSERT INTO invitations (tenant_id, project_id, token_hash, target_role, expires_at, created_by)
     VALUES ($1,NULL,$2,'member', now() + interval '1 day', $3) RETURNING id`,
    [seed.tenantId, sha256('bravo-tenant-token-xxxxxxxxxxxxxxxx'), seed.users.owner.id],
  );
  const tpl = await one(
    pool,
    `INSERT INTO onboarding_templates (tenant_id, project_id, name, created_by, updated_by) VALUES ($1,$2,'Bravo Onboarding',$3,$3) RETURNING id`,
    [seed.tenantId, seed.projectId, admin],
  );
  const step = await one(
    pool,
    `INSERT INTO onboarding_steps (tenant_id, project_id, template_id, knowledge_item_id, title) VALUES ($1,$2,$3,$4,'Bravo Step') RETURNING id`,
    [seed.tenantId, seed.projectId, tpl.id, item.id],
  );
  await query(
    pool,
    `INSERT INTO audit_logs (tenant_id, project_id, actor_user_id, action, target_type, target_id, outcome, metadata_json)
     VALUES ($1,$2,$3,'knowledge.created','knowledge_item',$4,'success','{"title":"Bravo Link"}'),
            ($1,NULL,$3,'tenant.created','tenant',$1,'success','{"name":"Bravo Org"}')`,
    [seed.tenantId, seed.projectId, admin, item.id],
  );
  return {
    seed, itemId: item.id, docId: doc.id, fileId: file.id, categoryId: cat.id, invitationId: inv.id, tenantInvitationId: tinv.id,
    templateId: tpl.id, stepId: step.id,
  };
}

function expectNoLeak(res: Res, b: BravoData) {
  const text = res.text.toLowerCase();
  expect(text).not.toContain('bravo');
  for (const id of [b.seed.tenantId, b.seed.projectId, b.itemId, b.docId, b.fileId, b.categoryId, b.seed.workspace.id]) {
    expect(text).not.toContain(id);
  }
}

function expect404(res: Res, b: BravoData) {
  expect(res.status, res.text).toBe(404);
  expect(res.body.error.code).toBe('NOT_FOUND');
  expectNoLeak(res, b);
}

describe('AC-001 tenant isolation', () => {
  let alpha: Seed;
  let bravo: BravoData;
  let a: Record<string, Session>;

  beforeEach(async () => {
    alpha = await seedProject('Alpha');
    bravo = await seedBravo();
    // Alpha's owner and project admin are the attackers.
    a = { admin: await login(alpha.users.admin.email), owner: await login(alpha.users.owner.email) };
  });

  it('reads of every Tenant B resource return 404 with no Tenant B data', async () => {
    const b = bravo;
    const p = b.seed.projectId;
    const t = b.seed.tenantId;
    const urls = [
      `/api/v1/projects/${p}`,
      `/api/v1/projects/${p}/overview`,
      `/api/v1/projects/${p}/knowledge`,
      `/api/v1/projects/${p}/knowledge?q=Bravo`,
      `/api/v1/projects/${p}/knowledge/duplicates?url=https://example.com`,
      `/api/v1/knowledge/${b.itemId}`,
      `/api/v1/knowledge/${b.docId}`,
      `/api/v1/knowledge/${b.docId}/content`,
      `/api/v1/files/${b.fileId}/download-url`,
      `/api/v1/files/${b.fileId}/status`,
      `/api/v1/projects/${p}/categories`,
      `/api/v1/projects/${p}/tags`,
      `/api/v1/projects/${p}/people`,
      `/api/v1/projects/${p}/members`,
      `/api/v1/projects/${p}/invitations`,
      `/api/v1/projects/${p}/audit-logs`,
      `/api/v1/projects/${p}/onboarding`,
      `/api/v1/projects/${p}/onboarding/templates`,
      `/api/v1/projects/${p}/onboarding/report`,
      `/api/v1/tenants/${t}`,
      `/api/v1/tenants/${t}/members`,
      `/api/v1/tenants/${t}/invitations`,
      `/api/v1/tenants/${t}/audit-logs`,
      `/api/v1/tenants/${t}/workspaces`,
      `/api/v1/tenants/${t}/dashboard`,
      `/api/v1/tenants/${t}/search?q=Bravo`,
      `/api/v1/workspaces/${b.seed.workspace.id}/projects`,
    ];
    for (const who of [a.admin, a.owner]) {
      for (const url of urls) {
        const res = await get(who, url);
        expect(res.status, `${url} → ${res.text}`).toBe(404);
        expectNoLeak(res, b);
      }
    }
  });

  it('Tenant A views of its own tenant never include Tenant B data', async () => {
    const t = alpha.tenantId;
    for (const url of [
      `/api/v1/me`,
      `/api/v1/tenants`,
      `/api/v1/me/tenants`,
      `/api/v1/tenants/${t}/dashboard`,
      `/api/v1/tenants/${t}/search?q=Bravo`,
      `/api/v1/tenants/${t}/workspaces`,
      `/api/v1/tenants/${t}/members`,
      `/api/v1/tenants/${t}/audit-logs`,
      `/api/v1/projects/${alpha.projectId}/knowledge?q=Bravo`,
      `/api/v1/projects/${alpha.projectId}/audit-logs`,
    ]) {
      const res = await get(url.includes('/projects/') ? a.admin : a.owner, url);
      expect(res.status, `${url} → ${res.text}`).toBe(200);
      expectNoLeak(res, bravo);
    }
  });

  it('mutations against Tenant B ids return 404 and change nothing', async () => {
    const b = bravo;
    const p = b.seed.projectId;
    const t = b.seed.tenantId;
    const victim = b.seed.users.admin;
    const before = await snapshotBravo(b);

    const attempts: [string, string, unknown?][] = [
      ['PATCH', `/api/v1/knowledge/${b.itemId}`, { version: 1, title: 'pwned' }],
      ['PUT', `/api/v1/knowledge/${b.docId}/content`, { version: 1, content: 'pwned' }],
      ['POST', `/api/v1/knowledge/${b.itemId}/archive`],
      ['POST', `/api/v1/knowledge/${b.itemId}/restore`],
      ['POST', `/api/v1/knowledge/${b.itemId}/pin`],
      ['DELETE', `/api/v1/knowledge/${b.itemId}/pin`],
      ['DELETE', `/api/v1/knowledge/${b.itemId}`],
      ['POST', `/api/v1/projects/${p}/knowledge`, { type: 'external_link', title: 'pwned', externalUrl: 'https://evil.example' }],
      ['PATCH', `/api/v1/projects/${p}`, { version: 1, name: 'pwned' }],
      ['POST', `/api/v1/projects/${p}/archive`],
      ['POST', `/api/v1/projects/${p}/categories`, { name: 'pwned' }],
      ['PATCH', `/api/v1/categories/${b.categoryId}`, { name: 'pwned' }],
      ['DELETE', `/api/v1/categories/${b.categoryId}?reassignTo=none`],
      ['POST', `/api/v1/projects/${p}/members`, { email: a.admin.email, role: 'project_admin' }],
      ['PATCH', `/api/v1/projects/${p}/members/${victim.id}`, { role: 'viewer' }],
      ['DELETE', `/api/v1/projects/${p}/members/${victim.id}`],
      ['POST', `/api/v1/projects/${p}/invitations`, { role: 'project_admin' }],
      ['POST', `/api/v1/invitations/${b.invitationId}/revoke`],
      ['POST', `/api/v1/invitations/${b.tenantInvitationId}/revoke`],
      ['POST', `/api/v1/tenants/${t}/invitations`, { role: 'member' }],
      ['PATCH', `/api/v1/tenants/${t}`, { name: 'pwned' }],
      ['PATCH', `/api/v1/tenants/${t}/members/${victim.id}`, { status: 'suspended' }],
      ['DELETE', `/api/v1/tenants/${t}/members/${victim.id}`],
      ['POST', `/api/v1/tenants/${t}/transfer-ownership`, { userId: a.admin.userId }],
      ['POST', `/api/v1/tenants/${t}/workspaces`, { name: 'pwned' }],
      ['PATCH', `/api/v1/workspaces/${b.seed.workspace.id}`, { status: 'archived' }],
      ['POST', `/api/v1/workspaces/${b.seed.workspace.id}/projects`, { name: 'pwned' }],
      ['POST', `/api/v1/projects/${p}/files/upload-init`, { filename: 'x.pdf', size: 10 }],
      ['POST', `/api/v1/files/${b.fileId}/upload-complete`],
      ['DELETE', `/api/v1/files/${b.fileId}`],
      ['POST', `/api/v1/projects/${p}/onboarding/templates`, { name: 'pwned' }],
      ['PATCH', `/api/v1/onboarding/templates/${b.templateId}`, { name: 'pwned' }],
      ['POST', `/api/v1/onboarding/templates/${b.templateId}/steps`, { title: 'pwned' }],
      ['PATCH', `/api/v1/onboarding/steps/${b.stepId}`, { title: 'pwned' }],
      ['DELETE', `/api/v1/onboarding/steps/${b.stepId}`],
      ['POST', `/api/v1/onboarding/steps/${b.stepId}/complete`, { completed: true }],
    ];
    for (const who of [a.admin, a.owner]) {
      for (const [method, url, body] of attempts) {
        const fn = method === 'POST' ? post : method === 'PATCH' ? patch : method === 'PUT' ? put : null;
        const res = fn ? await fn(who, url, body) : await del(who, url);
        expect(res.status, `${method} ${url} → ${res.text}`).toBe(404);
        expectNoLeak(res, b);
      }
    }
    expect(await snapshotBravo(b)).toEqual(before);
    expect(await count(`SELECT count(*) FROM knowledge_items WHERE title = 'pwned' OR tenant_id <> ALL($1::uuid[])`, [[alpha.tenantId, b.seed.tenantId]])).toBe(0);
  });

  it('Tenant B ids substituted into Tenant A requests are rejected without leaking', async () => {
    const b = bravo;
    const alphaItem = await createItem(alpha, alpha.users.admin.id, { title: 'Alpha item' });
    const alphaCat = await createCategory(alpha, 'Alpha Cat');
    const p = alpha.projectId;

    const cases: Res[] = [
      await post(a.admin, `/api/v1/projects/${p}/knowledge`, { type: 'external_link', title: 'x', externalUrl: 'https://a.example', categoryId: b.categoryId }),
      await post(a.admin, `/api/v1/projects/${p}/knowledge`, { type: 'external_link', title: 'x', externalUrl: 'https://a.example', ownerUserId: b.seed.users.admin.id }),
      await post(a.admin, `/api/v1/projects/${p}/knowledge`, { type: 'uploaded_file', title: 'x', fileId: b.fileId }),
      await patch(a.admin, `/api/v1/knowledge/${alphaItem.id}`, { version: 1, categoryId: b.categoryId }),
      await patch(a.admin, `/api/v1/knowledge/${alphaItem.id}`, { version: 1, ownerUserId: b.seed.users.admin.id }),
    ];
    for (const res of cases) {
      expect([404, 422], res.text).toContain(res.status);
      expectNoLeak(res, b);
    }
    // Deleting an in-use Alpha category may not reassign its items into a Bravo category.
    await query(pool, 'UPDATE knowledge_items SET category_id = $1 WHERE id = $2', [alphaCat.id, alphaItem.id]);
    const reassign = await del(a.admin, `/api/v1/categories/${alphaCat.id}?reassignTo=${b.categoryId}`);
    expect(reassign.status).toBe(422);

    // Onboarding step pointing at a Tenant B item.
    const tpl = await post(a.admin, `/api/v1/projects/${p}/onboarding/templates`, { name: 'Alpha Onb' });
    expect(tpl.status).toBe(201);
    const step = await post(a.admin, `/api/v1/onboarding/templates/${tpl.body.id}/steps`, { title: 'Read', knowledgeItemId: b.itemId });
    expect(step.status).toBe(422);
    expectNoLeak(step, b);

    // Members endpoints with a Tenant B user id / email.
    expect((await patch(a.admin, `/api/v1/projects/${p}/members/${b.seed.users.admin.id}`, { role: 'viewer' })).status).toBe(404);
    expect((await post(a.admin, `/api/v1/projects/${p}/members`, { email: b.seed.users.admin.email, role: 'viewer' })).status).toBe(404);
    expect((await patch(a.owner, `/api/v1/tenants/${alpha.tenantId}/members/${b.seed.users.admin.id}`, { role: 'admin' })).status).toBe(404);
    expect((await post(a.owner, `/api/v1/tenants/${alpha.tenantId}/transfer-ownership`, { userId: b.seed.users.owner.id })).status).toBe(404);

    // Nothing in Alpha now references Bravo rows.
    expect(await count(`SELECT count(*) FROM knowledge_items WHERE tenant_id = $1 AND (category_id = $2 OR owner_user_id = $3 OR file_id = $4)`,
      [alpha.tenantId, b.categoryId, b.seed.users.admin.id, b.fileId])).toBe(0);
    expect(await count(`SELECT count(*) FROM project_memberships WHERE project_id = $1 AND user_id = $2`, [p, b.seed.users.admin.id])).toBe(0);
  });

  it('the database rejects cross-tenant relationships even if a query slipped through', async () => {
    // Composite FKs: an Alpha item cannot point at a Bravo category or file.
    const alphaItem = await createItem(alpha, alpha.users.admin.id, { title: 'Alpha item' });
    await expect(pool.query('UPDATE knowledge_items SET category_id = $1 WHERE id = $2', [bravo.categoryId, alphaItem.id])).rejects.toThrow(/foreign key/);
    await expect(
      pool.query(`INSERT INTO project_memberships (tenant_id, project_id, user_id, role) VALUES ($1,$2,$3,'viewer')`, [alpha.tenantId, bravo.seed.projectId, alpha.users.admin.id]),
    ).rejects.toThrow(/foreign key/);
  });
});

async function snapshotBravo(b: BravoData) {
  const q = async (sql: string) => (await pool.query(sql, [b.seed.tenantId])).rows;
  return {
    items: await q(`SELECT id, title, status, is_pinned, version, category_id FROM knowledge_items WHERE tenant_id = $1 ORDER BY id`),
    docs: await q(`SELECT knowledge_item_id, content_md FROM knowledge_documents WHERE tenant_id = $1`),
    projects: await q(`SELECT id, name, status, version FROM projects WHERE tenant_id = $1`),
    cats: await q(`SELECT id, name FROM knowledge_categories WHERE tenant_id = $1 ORDER BY id`),
    pms: await q(`SELECT user_id, role, status FROM project_memberships WHERE tenant_id = $1 ORDER BY user_id`),
    tms: await q(`SELECT user_id, role, status FROM tenant_memberships WHERE tenant_id = $1 ORDER BY user_id`),
    invs: await q(`SELECT id, status FROM invitations WHERE tenant_id = $1 ORDER BY id`),
    tenant: await q(`SELECT name, status FROM tenants WHERE id = $1`),
    ws: await q(`SELECT id, name, status FROM workspaces WHERE tenant_id = $1 ORDER BY id`),
    files: await q(`SELECT id, upload_state, deleted_at FROM files WHERE tenant_id = $1`),
    onb: await q(`SELECT s.id, s.title, t.name FROM onboarding_steps s JOIN onboarding_templates t ON t.id = s.template_id WHERE s.tenant_id = $1`),
    progress: await q(`SELECT count(*) FROM onboarding_progress WHERE tenant_id = $1`),
  };
}

describe('AC-002 project membership (tenant roles do not imply project access)', () => {
  let s: Seed;
  let secretItem: string;
  let doc: string;
  let fileId: string;
  let sess: Record<string, Session>;

  beforeEach(async () => {
    s = await seedProject('Alpha');
    secretItem = (await createItem(s, s.users.admin.id, { title: 'Quokka roadmap', tags: ['quokka'] })).id;
    doc = (await createItem(s, s.users.admin.id, { type: 'internal_document', title: 'Quokka doc', content: 'Quokka body' })).id;
    fileId = (await createFile(s, s.users.admin.id, { scanStatus: 'clean' })).id;
    await createItem(s, s.users.admin.id, { type: 'uploaded_file', fileId, title: 'Quokka file' });
    sess = {
      owner: await login(s.users.owner.email),
      tenantAdmin: await login(s.users.tenantAdmin.email),
      outsider: await login(s.users.outsider.email),
      member: await login(s.users.member.email),
    };
  });

  for (const who of ['owner', 'tenantAdmin', 'outsider'] as const) {
    it(`tenant ${who} without project membership gets 404 for the project and its items`, async () => {
      const u = sess[who];
      for (const url of [
        `/api/v1/projects/${s.projectId}`,
        `/api/v1/projects/${s.projectId}/overview`,
        `/api/v1/projects/${s.projectId}/knowledge`,
        `/api/v1/projects/${s.projectId}/categories`,
        `/api/v1/projects/${s.projectId}/tags`,
        `/api/v1/projects/${s.projectId}/people`,
        `/api/v1/projects/${s.projectId}/onboarding`,
        `/api/v1/projects/${s.projectId}/audit-logs`,
        `/api/v1/knowledge/${secretItem}`,
        `/api/v1/knowledge/${doc}/content`,
        `/api/v1/files/${fileId}/download-url`,
      ]) {
        const res = await get(u, url);
        expect(res.status, `${url} → ${res.text}`).toBe(404);
        expect(res.text.toLowerCase()).not.toContain('quokka');
      }
      for (const res of [
        await patch(u, `/api/v1/knowledge/${secretItem}`, { version: 1, title: 'x' }),
        await post(u, `/api/v1/projects/${s.projectId}/knowledge`, { type: 'external_link', title: 'x', externalUrl: 'https://x.example' }),
        await post(u, `/api/v1/projects/${s.projectId}/members`, { email: s.users.owner.email, role: 'project_admin' }),
        await post(u, `/api/v1/projects/${s.projectId}/invitations`, { role: 'project_admin' }),
      ]) {
        expect(res.status, res.text).toBe(404);
      }

      // Excluded from dashboard, counts and cross-project search.
      const dash = await get(u, `/api/v1/tenants/${s.tenantId}/dashboard`);
      expect(dash.status).toBe(200);
      expect(dash.body.projects).toEqual([]);
      expect(dash.body.recentKnowledge).toEqual([]);
      expect(dash.text.toLowerCase()).not.toContain('quokka');
      const search = await get(u, `/api/v1/tenants/${s.tenantId}/search?q=Quokka`);
      expect(search.status).toBe(200);
      expect(search.body.data).toEqual([]);
    });
  }

  it('project member sees the project in dashboard and search (control)', async () => {
    const dash = await get(sess.member, `/api/v1/tenants/${s.tenantId}/dashboard`);
    expect(dash.body.projects.map((p: any) => p.id)).toEqual([s.projectId]);
    expect(dash.body.projects[0].itemCount).toBe(3);
    const search = await get(sess.member, `/api/v1/tenants/${s.tenantId}/search?q=Quokka`);
    expect(search.body.data.length).toBe(3);
  });

  it('tenant admin listing workspace projects sees the project with myRole null but still cannot open it', async () => {
    for (const who of ['tenantAdmin', 'owner'] as const) {
      const list = await get(sess[who], `/api/v1/workspaces/${s.workspace.id}/projects`);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ id: s.projectId, myRole: null });
      expect(list.text.toLowerCase()).not.toContain('quokka');
      expect((await get(sess[who], `/api/v1/projects/${s.projectId}`)).status).toBe(404);
      expect((await get(sess[who], `/api/v1/projects/${s.projectId}/knowledge`)).status).toBe(404);
      const ws = await get(sess[who], `/api/v1/tenants/${s.tenantId}/workspaces`);
      expect(ws.body.data[0].projectCount).toBe(1);
    }
  });

  it('plain tenant member does not see non-member projects in workspace listings', async () => {
    const list = await get(sess.outsider, `/api/v1/workspaces/${s.workspace.id}/projects`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    const ws = await get(sess.outsider, `/api/v1/tenants/${s.tenantId}/workspaces`);
    expect(ws.body.data[0].projectCount).toBe(0);
    const memberList = await get(sess.member, `/api/v1/workspaces/${s.workspace.id}/projects`);
    expect(memberList.body.data[0]).toMatchObject({ id: s.projectId, myRole: 'member' });
  });

  it('a suspended tenant membership blocks project access too', async () => {
    await query(pool, `UPDATE tenant_memberships SET status = 'suspended' WHERE tenant_id = $1 AND user_id = $2`, [s.tenantId, s.users.member.id]);
    expect((await get(sess.member, `/api/v1/projects/${s.projectId}`)).status).toBe(404);
    expect((await get(sess.member, `/api/v1/knowledge/${secretItem}`)).status).toBe(404);
    expect((await get(sess.member, `/api/v1/tenants/${s.tenantId}/dashboard`)).status).toBe(404);
  });

  it('item hidden from a role is excluded from that member\'s tenant dashboard count', async () => {
    await createItem(s, s.users.admin.id, { title: 'Hidden', rules: { member: HIDDEN } });
    const dash = await get(sess.member, `/api/v1/tenants/${s.tenantId}/dashboard`);
    expect(dash.body.projects[0].itemCount).toBe(3);
  });
});
