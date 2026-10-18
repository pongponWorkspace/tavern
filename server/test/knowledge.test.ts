// Knowledge items: AC-003 viewer read-only, AC-004/AC-013 item visibility,
// AC-005 edit policy, AC-010 document content, AC-014 archive, optimistic
// concurrency, and archived-project read-only behaviour.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HIDDEN,
  count,
  createCategory,
  createItem,
  del,
  get,
  loginAll,
  one,
  patch,
  pool,
  post,
  put,
  query,
  seedProject,
  setPolicy,
  useTestApp,
  type Res,
  type Seed,
  type Session,
} from './helpers.js';

useTestApp();

let s: Seed;
let as: Awaited<ReturnType<typeof loginAll>>;

beforeEach(async () => {
  s = await seedProject('Alpha');
  as = await loginAll(s.users);
});

const itemUrl = (id: string) => `/api/v1/knowledge/${id}`;
const listUrl = (q = '') => `/api/v1/projects/${s.projectId}/knowledge${q}`;

async function itemRow(id: string) {
  return one(pool, `SELECT title, description, status, is_pinned, version, updated_by, category_id FROM knowledge_items WHERE id = $1`, [id]);
}

async function snapshotItems() {
  return (await pool.query(`SELECT id, title, description, status, is_pinned, version, updated_by FROM knowledge_items ORDER BY id`)).rows;
}

// ───────────────────────── AC-003 ─────────────────────────

describe('AC-003 viewer is read-only', () => {
  it('create / edit / content / archive / restore / delete / pin are rejected and nothing changes', async () => {
    const link = await createItem(s, s.users.admin.id, { title: 'Link' });
    const doc = await createItem(s, s.users.admin.id, { type: 'internal_document', title: 'Doc', content: 'body' });
    const archived = await createItem(s, s.users.admin.id, { title: 'Old', status: 'archived' });
    const before = await snapshotItems();
    const docBefore = await one(pool, 'SELECT content_md FROM knowledge_documents WHERE knowledge_item_id = $1', [doc.id]);

    const v = as.viewer;
    const create = await post(v, listUrl(), { type: 'external_link', title: 'New', externalUrl: 'https://example.com/new' });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('FORBIDDEN');
    const createDoc = await post(v, listUrl(), { type: 'internal_document', title: 'New doc', content: 'x' });
    expect(createDoc.status).toBe(403);

    expect((await patch(v, itemUrl(link.id), { version: 1, title: 'Hacked' })).status).toBe(403);
    expect((await put(v, `${itemUrl(doc.id)}/content`, { version: 1, content: 'Hacked' })).status).toBe(403);
    expect((await post(v, `${itemUrl(link.id)}/archive`)).status).toBe(403);
    expect((await post(v, `${itemUrl(link.id)}/pin`)).status).toBe(403);
    expect((await del(v, `${itemUrl(link.id)}/pin`)).status).toBe(403);
    expect((await del(v, itemUrl(link.id))).status).toBe(403);
    // Archived items are concealed from roles that cannot manage them.
    expect((await post(v, `${itemUrl(archived.id)}/restore`)).status).toBe(404);
    expect((await del(v, itemUrl(archived.id))).status).toBe(404);
    expect((await post(v, `/api/v1/projects/${s.projectId}/categories`, { name: 'New cat' })).status).toBe(403);

    expect(await snapshotItems()).toEqual(before);
    expect(await one(pool, 'SELECT content_md FROM knowledge_documents WHERE knowledge_item_id = $1', [doc.id])).toEqual(docBefore);
    expect(await count('SELECT count(*) FROM knowledge_categories')).toBe(0);
  });

  it('viewer can read and is told every action is unavailable', async () => {
    const link = await createItem(s, s.users.admin.id, { title: 'Link' });
    const res = await get(as.viewer, itemUrl(link.id));
    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual({ edit: false, archive: false, delete: false, pin: false, restrict: false });
    expect(res.body.access).toBeUndefined();
    const list = await get(as.viewer, listUrl());
    expect(list.body.data[0].permissions).toEqual({ edit: false, archive: false, pin: false, delete: false });
    const project = await get(as.viewer, `/api/v1/projects/${s.projectId}`);
    expect(Object.values(project.body.permissions).every((v) => v === false)).toBe(true);
  });
});

describe('role escalation checks', () => {
  it('maintainer edits and archives but cannot delete, manage members, invite, or view audit', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'Item' });
    const m = as.maintainer;
    expect((await patch(m, itemUrl(item.id), { version: 1, title: 'Edited by maintainer' })).status).toBe(200);
    expect((await post(m, `${itemUrl(item.id)}/archive`)).status).toBe(200);
    expect((await del(m, itemUrl(item.id))).status).toBe(403);
    expect((await get(m, `/api/v1/projects/${s.projectId}/members`)).status).toBe(403);
    expect((await patch(m, `/api/v1/projects/${s.projectId}/members/${s.users.maintainer.id}`, { role: 'project_admin' })).status).toBe(403);
    expect((await post(m, `/api/v1/projects/${s.projectId}/members`, { email: s.users.outsider.email, role: 'viewer' })).status).toBe(403);
    expect((await post(m, `/api/v1/projects/${s.projectId}/invitations`, { role: 'viewer' })).status).toBe(403);
    expect((await get(m, `/api/v1/projects/${s.projectId}/audit-logs`)).status).toBe(403);
    expect((await patch(m, `/api/v1/projects/${s.projectId}`, { version: 1, policy: { memberEdit: 'all' } })).status).toBe(403);
    expect((await post(m, `/api/v1/projects/${s.projectId}/archive`)).status).toBe(403);
    expect(await one(pool, 'SELECT role FROM project_memberships WHERE user_id = $1', [s.users.maintainer.id])).toEqual({ role: 'maintainer' });
    expect(await count('SELECT count(*) FROM invitations')).toBe(0);
  });

  it('member cannot pin, archive, restrict access, or manage categories', async () => {
    const own = await post(as.member, listUrl(), { type: 'external_link', title: 'Mine', externalUrl: 'https://example.com/mine' });
    expect(own.status).toBe(201);
    expect((await post(as.member, `${itemUrl(own.body.id)}/pin`)).status).toBe(403);
    expect((await post(as.member, `${itemUrl(own.body.id)}/archive`)).status).toBe(403);
    expect((await patch(as.member, itemUrl(own.body.id), { version: 1, visibilityRoles: ['project_admin'] })).status).toBe(403);
    expect((await post(as.member, listUrl(), { type: 'external_link', title: 'Pinned', externalUrl: 'https://example.com/p', isPinned: true })).status).toBe(403);
    expect((await post(as.member, listUrl(), { type: 'external_link', title: 'R', externalUrl: 'https://example.com/r', visibilityRoles: ['project_admin'] })).status).toBe(403);
    expect((await post(as.member, `/api/v1/projects/${s.projectId}/categories`, { name: 'Cat' })).status).toBe(403);
    expect(await itemRow(own.body.id)).toMatchObject({ status: 'active', is_pinned: false, version: 1 });
    expect(await count('SELECT count(*) FROM knowledge_item_access_rules')).toBe(0);
  });

  it('maintainer cannot lock their own role out of an item, nor grant roles beyond their base', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'Item' });
    const lockOut = await patch(as.maintainer, itemUrl(item.id), { version: 1, visibilityRoles: ['project_admin'] });
    expect(lockOut.status).toBe(422);
    const viewerEdit = await patch(as.maintainer, itemUrl(item.id), { version: 1, editRoles: ['project_admin', 'maintainer', 'viewer'] });
    expect(viewerEdit.status).toBe(422);
    const memberArchive = await patch(as.admin, itemUrl(item.id), { version: 1, archiveRoles: ['project_admin', 'member'] });
    expect(memberArchive.status).toBe(422);
    const noAdmin = await patch(as.admin, itemUrl(item.id), { version: 1, visibilityRoles: ['maintainer'] });
    expect(noAdmin.status).toBe(422);
    expect(await count('SELECT count(*) FROM knowledge_item_access_rules')).toBe(0);
    expect((await itemRow(item.id)).version).toBe(1);
  });
});

describe('maintainers can tighten but not loosen item restrictions', () => {
  it('cannot re-expose an item an admin hid, or regain archive an admin removed', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'Sensitive' });
    const hide = await patch(as.admin, itemUrl(item.id), {
      version: 1,
      visibilityRoles: ['project_admin', 'maintainer'],
      archiveRoles: ['project_admin'],
    });
    expect(hide.status).toBe(200);
    const v = hide.body.version;
    const unhide = await patch(as.maintainer, itemUrl(item.id), { version: v, visibilityRoles: ['project_admin', 'maintainer', 'member', 'viewer'] });
    expect(unhide.status).toBe(403);
    const regainArchive = await patch(as.maintainer, itemUrl(item.id), { version: v, visibilityRoles: ['project_admin', 'maintainer'], archiveRoles: ['project_admin', 'maintainer'] });
    expect(regainArchive.status).toBe(403);
    expect((await get(as.member, itemUrl(item.id))).status).toBe(404);
    // Tightening further is still allowed.
    const tighten = await patch(as.maintainer, itemUrl(item.id), { version: v, visibilityRoles: ['project_admin', 'maintainer'], editRoles: ['project_admin', 'maintainer'], archiveRoles: ['project_admin'] });
    expect(tighten.status).toBe(200);
  });
});

// ───────────────────────── AC-004 / AC-013 ─────────────────────────

describe('AC-004 / AC-013 restricted item is invisible to excluded roles', () => {
  let secret: string;
  let pub: string;
  let catId: string;

  beforeEach(async () => {
    const cat = await createCategory(s, 'Guides');
    catId = cat.id;
    // Created through the API so the stored rules come from buildItemRules.
    const created = await post(as.admin, listUrl(), {
      type: 'internal_document', title: 'Zebra Roadmap Classified', description: 'Okapi plans', content: 'TOP-SECRET-BODY',
      categoryId: cat.id, tags: ['okapi-tag'], isPinned: true, visibilityRoles: ['project_admin', 'maintainer'],
    });
    expect(created.status).toBe(201);
    expect(created.body.access).toMatchObject({ visibilityRoles: ['project_admin', 'maintainer'], restricted: true });
    secret = created.body.id;
    pub = (await createItem(s, s.users.admin.id, { title: 'Zebra public notes', categoryId: cat.id, tags: ['shared'] })).id;

    const tpl = await post(as.admin, `/api/v1/projects/${s.projectId}/onboarding/templates`, { name: 'Start here' });
    expect(tpl.status).toBe(201);
    const step = await post(as.admin, `/api/v1/onboarding/templates/${tpl.body.id}/steps`, { title: 'Read the plan', knowledgeItemId: secret });
    expect(step.status).toBe(201);
    const step2 = await post(as.admin, `/api/v1/onboarding/templates/${tpl.body.id}/steps`, { title: 'Read notes', knowledgeItemId: pub });
    expect(step2.status).toBe(201);
  });

  const LEAKS = ['roadmap', 'classified', 'okapi', 'top-secret'];
  const noLeak = (res: Res, ctx: string) => {
    const text = res.text.toLowerCase();
    for (const w of LEAKS) expect(text, `${ctx} leaked "${w}"`).not.toContain(w);
    expect(res.text, ctx).not.toContain(secret);
  };

  for (const role of ['member', 'viewer'] as const) {
    it(`${role}: absent from list, search, counts, categories, tags, overview, dashboard, tenant search, onboarding`, async () => {
      const u: Session = as[role];
      const checks: [string, (r: Res) => void][] = [
        [listUrl(), (r) => {
          expect(r.body.data.map((i: any) => i.id)).toEqual([pub]);
          expect(r.body.page.total).toBe(1);
        }],
        [listUrl('?q=Zebra'), (r) => {
          expect(r.body.data.map((i: any) => i.id)).toEqual([pub]);
          expect(r.body.page.total).toBe(1);
        }],
        [listUrl('?q=Roadmap'), (r) => expect(r.body).toMatchObject({ data: [], page: { total: 0 } })],
        [listUrl('?q=okapi'), (r) => expect(r.body.page.total).toBe(0)],
        [listUrl('?tag=okapi-tag'), (r) => expect(r.body.page.total).toBe(0)],
        [listUrl('?pinned=true'), (r) => expect(r.body.page.total).toBe(0)],
        [listUrl(`?categoryId=${catId}`), (r) => expect(r.body.page.total).toBe(1)],
        [listUrl('?type=internal_document'), (r) => expect(r.body.page.total).toBe(0)],
        [`/api/v1/projects/${s.projectId}/categories`, (r) => expect(r.body.data[0]).toMatchObject({ id: catId, itemCount: 1 })],
        [`/api/v1/projects/${s.projectId}/tags`, (r) => expect(r.body.data.map((t: any) => t.slug)).toEqual(['shared'])],
        [`/api/v1/projects/${s.projectId}/overview`, (r) => {
          expect(r.body.pinned).toEqual([]);
          expect(r.body.recent.map((i: any) => i.id)).toEqual([pub]);
          expect(r.body.counts).toEqual({ total: 1, links: 1, files: 0, documents: 0 });
          expect(r.body.categories).toEqual([{ id: catId, name: 'Guides', itemCount: 1 }]);
        }],
        [`/api/v1/tenants/${s.tenantId}/dashboard`, (r) => {
          expect(r.body.recentKnowledge.map((i: any) => i.id)).toEqual([pub]);
          expect(r.body.projects[0].itemCount).toBe(1);
        }],
        [`/api/v1/tenants/${s.tenantId}/search?q=Zebra`, (r) => expect(r.body.data.map((i: any) => i.id)).toEqual([pub])],
        [`/api/v1/tenants/${s.tenantId}/search?q=Roadmap`, (r) => expect(r.body.data).toEqual([])],
        [`/api/v1/projects/${s.projectId}/onboarding`, (r) => {
          const steps = r.body.templates[0].steps;
          expect(steps.find((x: any) => x.title === 'Read the plan').resource).toBeNull();
          expect(steps.find((x: any) => x.title === 'Read notes').resource).toMatchObject({ id: pub });
        }],
      ];
      for (const [url, check] of checks) {
        const res = await get(u, url);
        expect(res.status, `${url} → ${res.text}`).toBe(200);
        check(res);
        noLeak(res, url);
      }

      // Direct URLs are concealed.
      for (const url of [itemUrl(secret), `${itemUrl(secret)}/content`]) {
        const res = await get(u, url);
        expect(res.status, url).toBe(404);
        noLeak(res, url);
      }
      for (const res of [
        await patch(u, itemUrl(secret), { version: 1, title: 'x' }),
        await put(u, `${itemUrl(secret)}/content`, { version: 1, content: 'x' }),
        await post(u, `${itemUrl(secret)}/archive`),
        await post(u, `${itemUrl(secret)}/pin`),
      ]) {
        expect(res.status).toBe(404);
        noLeak(res, 'mutation');
      }
    });
  }

  it('maintainer (allowed role) and admin still see it everywhere', async () => {
    for (const u of [as.maintainer, as.admin]) {
      const list = await get(u, listUrl('?q=Zebra'));
      expect(list.body.page.total).toBe(2);
      expect((await get(u, `${itemUrl(secret)}/content`)).body.content).toBe('TOP-SECRET-BODY');
      expect((await get(u, `/api/v1/projects/${s.projectId}/categories`)).body.data[0].itemCount).toBe(2);
      expect((await get(u, `/api/v1/projects/${s.projectId}/overview`)).body.pinned.map((i: any) => i.id)).toEqual([secret]);
    }
  });

  it('member cannot link the hidden item into onboarding even with manage rights', async () => {
    await setPolicy(s.projectId, { memberOnboarding: true });
    const tpl = await post(as.member, `/api/v1/projects/${s.projectId}/onboarding/templates`, { name: 'Member guide' });
    expect(tpl.status).toBe(201);
    const step = await post(as.member, `/api/v1/onboarding/templates/${tpl.body.id}/steps`, { title: 'x', knowledgeItemId: secret });
    expect(step.status).toBe(422);
    const templates = await get(as.member, `/api/v1/projects/${s.projectId}/onboarding/templates`);
    noLeak(templates, 'templates');
    const hidden = templates.body.data.flatMap((t: any) => t.steps).find((x: any) => x.title === 'Read the plan');
    expect(hidden.resource).toEqual({ id: null, title: null, hidden: true });
  });

  it('removing the restriction makes the item visible again on the next request', async () => {
    const detail = await get(as.admin, itemUrl(secret));
    const res = await patch(as.admin, itemUrl(secret), { version: detail.body.version, visibilityRoles: ['project_admin', 'maintainer', 'member', 'viewer'] });
    expect(res.status).toBe(200);
    expect((await get(as.member, itemUrl(secret))).status).toBe(200);
    expect((await get(as.member, listUrl())).body.page.total).toBe(2);
  });
});

// ───────────────────────── AC-005 ─────────────────────────

describe('AC-005 item edit policy', () => {
  it('member who can view but not edit (item rule) gets 403 and the row is untouched', async () => {
    await setPolicy(s.projectId, { memberEdit: 'all' });
    const created = await post(as.admin, listUrl(), {
      type: 'internal_document', title: 'Policy doc', content: 'original', editRoles: ['project_admin', 'maintainer'],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const before = await itemRow(id);

    const res = await patch(as.member, itemUrl(id), { version: 1, title: 'Changed', description: 'Changed', tags: ['x'] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await put(as.member, `${itemUrl(id)}/content`, { version: 1, content: 'changed' })).status).toBe(403);

    expect(await itemRow(id)).toEqual(before);
    expect((await get(as.member, `${itemUrl(id)}/content`)).body.content).toBe('original');
    expect(await count('SELECT count(*) FROM knowledge_item_tags')).toBe(0);
    expect(await count(`SELECT count(*) FROM audit_logs WHERE action IN ('knowledge.updated','knowledge.content_updated')`)).toBe(0);
    // Member can still read it.
    expect((await get(as.member, itemUrl(id))).body.permissions.edit).toBe(false);
  });

  it("policy 'own': member edits own item, not others'", async () => {
    await setPolicy(s.projectId, { memberEdit: 'own' });
    const mine = await post(as.member, listUrl(), { type: 'external_link', title: 'Mine', externalUrl: 'https://example.com/mine' });
    expect(mine.status).toBe(201);
    const theirs = await createItem(s, s.users.maintainer.id, { title: 'Theirs' });

    const ok = await patch(as.member, itemUrl(mine.body.id), { version: 1, title: 'Mine v2' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: 'Mine v2', version: 2 });

    const denied = await patch(as.member, itemUrl(theirs.id), { version: 1, title: 'Stolen' });
    expect(denied.status).toBe(403);
    expect(await itemRow(theirs.id)).toMatchObject({ title: 'Theirs', version: 1 });
  });

  it("policy 'none': member cannot edit even their own item", async () => {
    const mine = await post(as.member, listUrl(), { type: 'external_link', title: 'Mine', externalUrl: 'https://example.com/mine' });
    await setPolicy(s.projectId, { memberEdit: 'none' });
    expect((await patch(as.member, itemUrl(mine.body.id), { version: 1, title: 'x' })).status).toBe(403);
    expect(await itemRow(mine.body.id)).toMatchObject({ title: 'Mine', version: 1 });
  });

  it("policy 'all': member edits anyone's item; maintainer always can", async () => {
    const theirs = await createItem(s, s.users.admin.id, { title: 'Theirs' });
    // Changed through the API by the project admin.
    const pol = await put(as.admin, `/api/v1/projects/${s.projectId}/role-permissions`, { permissions: { member: { edit: 'all' } } });
    expect(pol.status).toBe(200);
    expect((await patch(as.member, itemUrl(theirs.id), { version: 1, title: 'By member' })).status).toBe(200);
    expect((await patch(as.maintainer, itemUrl(theirs.id), { version: 2, title: 'By maintainer' })).status).toBe(200);
    expect(await itemRow(theirs.id)).toMatchObject({ title: 'By maintainer', version: 3, updated_by: s.users.maintainer.id });
  });

  it('memberCreate=false blocks member creation; role change applies on the next request', async () => {
    await setPolicy(s.projectId, { memberCreate: false });
    expect((await post(as.member, listUrl(), { type: 'external_link', title: 'x', externalUrl: 'https://example.com' })).status).toBe(403);
    expect(await count('SELECT count(*) FROM knowledge_items')).toBe(0);
    // Promote to maintainer: allowed immediately with the same session.
    await query(pool, `UPDATE project_memberships SET role = 'maintainer' WHERE user_id = $1`, [s.users.member.id]);
    expect((await post(as.member, listUrl(), { type: 'external_link', title: 'x', externalUrl: 'https://example.com' })).status).toBe(201);
  });

  it('user who loses edit rights while editing is denied at save time', async () => {
    const item = await createItem(s, s.users.admin.id, { type: 'internal_document', title: 'Doc', content: 'v1' });
    const open = await get(as.maintainer, `${itemUrl(item.id)}/content`);
    expect(open.status).toBe(200);
    await query(pool, `UPDATE project_memberships SET role = 'viewer' WHERE user_id = $1`, [s.users.maintainer.id]);
    expect((await put(as.maintainer, `${itemUrl(item.id)}/content`, { version: open.body.version, content: 'v2' })).status).toBe(403);
    expect((await get(as.admin, `${itemUrl(item.id)}/content`)).body.content).toBe('v1');
  });

  it('rejects unsafe external URLs at the API', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://u:p@example.com']) {
      const res = await post(as.admin, listUrl(), { type: 'external_link', title: 'Bad', externalUrl: url });
      expect(res.status, url).toBe(422);
    }
    const item = await createItem(s, s.users.admin.id, { title: 'Good' });
    expect((await patch(as.admin, itemUrl(item.id), { version: 1, externalUrl: 'javascript:alert(1)' })).status).toBe(422);
    expect(await count('SELECT count(*) FROM knowledge_items')).toBe(1);
  });
});

// ───────────────────────── AC-010 ─────────────────────────

describe('AC-010 internal document content requires view permission', () => {
  it('content is returned only to users who can view the item', async () => {
    const open = await createItem(s, s.users.admin.id, { type: 'internal_document', title: 'Open doc', content: 'open body' });
    const hidden = await createItem(s, s.users.admin.id, {
      type: 'internal_document', title: 'Hidden doc', content: 'hidden body', rules: { viewer: HIDDEN, member: HIDDEN },
    });
    for (const u of [as.viewer, as.member, as.maintainer, as.admin]) {
      expect((await get(u, `${itemUrl(open.id)}/content`)).body.content).toBe('open body');
    }
    for (const u of [as.viewer, as.member, as.outsider, as.owner, as.tenantAdmin]) {
      const res = await get(u, `${itemUrl(hidden.id)}/content`);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('hidden body');
    }
    expect((await get(as.maintainer, `${itemUrl(hidden.id)}/content`)).body.content).toBe('hidden body');
    // Unauthenticated callers get 401, never content.
    const anon = await get(null, `${itemUrl(open.id)}/content`);
    expect(anon.status).toBe(401);
    expect(anon.text).not.toContain('open body');
  });

  it('content endpoint 404s for non-document items and archived documents for viewers', async () => {
    const link = await createItem(s, s.users.admin.id, { title: 'Link' });
    expect((await get(as.admin, `${itemUrl(link.id)}/content`)).status).toBe(404);
    const archived = await createItem(s, s.users.admin.id, { type: 'internal_document', title: 'Old doc', content: 'old body', status: 'archived' });
    const res = await get(as.viewer, `${itemUrl(archived.id)}/content`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('old body');
  });
});

// ───────────────────────── AC-014 ─────────────────────────

describe('AC-014 archived items', () => {
  it('excluded from normal results, visible to admin with status=archived, restorable', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'Archivable', isPinned: true });
    const keep = await createItem(s, s.users.admin.id, { title: 'Keep' });
    const arch = await post(as.admin, `${itemUrl(item.id)}/archive`);
    expect(arch.status).toBe(200);
    expect(arch.body).toMatchObject({ status: 'archived', isPinned: false });

    for (const u of [as.member, as.viewer, as.admin]) {
      const list = await get(u, listUrl());
      expect(list.body.data.map((i: any) => i.id)).toEqual([keep.id]);
      expect(list.body.page.total).toBe(1);
      expect((await get(u, `/api/v1/tenants/${s.tenantId}/search?q=Archivable`)).body.data).toEqual([]);
      expect((await get(u, `/api/v1/projects/${s.projectId}/overview`)).body.counts.total).toBe(1);
    }
    for (const u of [as.member, as.viewer]) {
      const res = await get(u, listUrl('?status=archived'));
      expect(res.status).toBe(403);
      expect(res.text).not.toContain('Archivable');
      expect((await get(u, itemUrl(item.id))).status).toBe(404);
    }

    const archivedList = await get(as.admin, listUrl('?status=archived'));
    expect(archivedList.status).toBe(200);
    expect(archivedList.body.data.map((i: any) => i.id)).toEqual([item.id]);
    // Maintainer with maintainerArchive=true may also see archived items.
    expect((await get(as.maintainer, listUrl('?status=archived'))).body.page.total).toBe(1);

    const restored = await post(as.admin, `${itemUrl(item.id)}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe('active');
    expect((await get(as.member, listUrl())).body.page.total).toBe(2);
    expect((await get(as.member, itemUrl(item.id))).status).toBe(200);
  });

  it('maintainerArchive=false removes maintainer archive and archived view', async () => {
    await setPolicy(s.projectId, { maintainerArchive: false });
    const item = await createItem(s, s.users.admin.id, { title: 'X' });
    expect((await post(as.maintainer, `${itemUrl(item.id)}/archive`)).status).toBe(403);
    expect((await get(as.maintainer, listUrl('?status=archived'))).status).toBe(403);
    expect((await itemRow(item.id)).status).toBe('active');
  });

  it('archived items cannot be edited or pinned until restored; delete requires archive first', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'X' });
    expect((await del(as.admin, itemUrl(item.id))).status).toBe(409);
    await post(as.admin, `${itemUrl(item.id)}/archive`);
    const v = (await itemRow(item.id)).version;
    expect((await patch(as.admin, itemUrl(item.id), { version: v, title: 'y' })).status).toBe(409);
    expect((await post(as.admin, `${itemUrl(item.id)}/pin`)).status).toBe(409);
    expect((await del(as.maintainer, itemUrl(item.id))).status).toBe(403);
    const gone = await del(as.admin, itemUrl(item.id));
    expect(gone.status).toBe(200);
    expect((await get(as.admin, itemUrl(item.id))).status).toBe(404);
    expect(await count('SELECT count(*) FROM knowledge_items')).toBe(0);
  });
});

// ───────────────────────── Concurrency & read-only ─────────────────────────

describe('optimistic concurrency', () => {
  it('stale item PATCH returns 409 with the current version and does not overwrite', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'Original' });
    const first = await patch(as.admin, itemUrl(item.id), { version: 1, title: 'First writer' });
    expect(first.status).toBe(200);
    const stale = await patch(as.maintainer, itemUrl(item.id), { version: 1, title: 'Second writer' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 2 } });
    expect(await itemRow(item.id)).toMatchObject({ title: 'First writer', version: 2 });
  });

  it('concurrent PATCHes with the same version: exactly one wins', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'Original' });
    const results = await Promise.all([
      patch(as.admin, itemUrl(item.id), { version: 1, title: 'A' }),
      patch(as.maintainer, itemUrl(item.id), { version: 1, title: 'B' }),
      patch(as.admin, itemUrl(item.id), { version: 1, title: 'C' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await itemRow(item.id)).version).toBe(2);
  });

  it('stale document content save and stale project settings return 409', async () => {
    const doc = await createItem(s, s.users.admin.id, { type: 'internal_document', title: 'Doc', content: 'v1' });
    expect((await put(as.admin, `${itemUrl(doc.id)}/content`, { version: 1, content: 'v2' })).body).toEqual({ ok: true, version: 2 });
    const stale = await put(as.maintainer, `${itemUrl(doc.id)}/content`, { version: 1, content: 'stale' });
    expect(stale.status).toBe(409);
    expect((await get(as.admin, `${itemUrl(doc.id)}/content`)).body.content).toBe('v2');

    expect((await patch(as.admin, `/api/v1/projects/${s.projectId}`, { version: 1, name: 'Renamed' })).status).toBe(200);
    expect((await patch(as.admin, `/api/v1/projects/${s.projectId}`, { version: 1, name: 'Stale' })).status).toBe(409);
    expect((await one(pool, 'SELECT name FROM projects WHERE id = $1', [s.projectId])).name).toBe('Renamed');
  });
});

describe('archived project is read-only but readable', () => {
  it('mutations return 409 READ_ONLY; reads still work; restore re-enables writes', async () => {
    const item = await createItem(s, s.users.admin.id, { type: 'internal_document', title: 'Doc', content: 'body' });
    const cat = await createCategory(s, 'Cat');
    expect((await post(as.admin, `/api/v1/projects/${s.projectId}/archive`)).status).toBe(200);

    const project = await get(as.member, `/api/v1/projects/${s.projectId}`);
    expect(project.status).toBe(200);
    expect(project.body).toMatchObject({ status: 'archived', writable: false });
    expect((await get(as.member, listUrl())).body.page.total).toBe(1);
    expect((await get(as.member, `${itemUrl(item.id)}/content`)).body.content).toBe('body');
    expect((await get(as.admin, itemUrl(item.id))).body.permissions).toEqual({ edit: false, archive: false, delete: false, pin: false, restrict: false });

    const before = await snapshotItems();
    const attempts: Res[] = [
      await post(as.admin, listUrl(), { type: 'external_link', title: 'x', externalUrl: 'https://example.com' }),
      await patch(as.admin, itemUrl(item.id), { version: 1, title: 'x' }),
      await put(as.admin, `${itemUrl(item.id)}/content`, { version: 1, content: 'x' }),
      await post(as.admin, `${itemUrl(item.id)}/archive`),
      await post(as.admin, `${itemUrl(item.id)}/pin`),
      await post(as.admin, `/api/v1/projects/${s.projectId}/categories`, { name: 'New' }),
      await patch(as.admin, `/api/v1/categories/${cat.id}`, { name: 'Renamed' }),
      await post(as.admin, `/api/v1/projects/${s.projectId}/invitations`, { role: 'viewer' }),
      await post(as.admin, `/api/v1/projects/${s.projectId}/members`, { email: s.users.outsider.email, role: 'viewer' }),
      await patch(as.admin, `/api/v1/projects/${s.projectId}/members/${s.users.viewer.id}`, { role: 'member' }),
      await patch(as.admin, `/api/v1/projects/${s.projectId}`, { version: 2, name: 'Renamed project' }),
      await post(as.admin, `/api/v1/projects/${s.projectId}/files/upload-init`, { filename: 'a.pdf', size: 10 }),
      await post(as.member, listUrl(), { type: 'external_link', title: 'x', externalUrl: 'https://example.com' }),
    ];
    for (const res of attempts) {
      expect(res.status, res.text).toBe(409);
      expect(res.body.error.code).toBe('READ_ONLY');
    }
    expect(await snapshotItems()).toEqual(before);
    expect(await count('SELECT count(*) FROM invitations')).toBe(0);
    expect(await count('SELECT count(*) FROM files')).toBe(0);
    expect(await one(pool, 'SELECT name FROM knowledge_categories WHERE id = $1', [cat.id])).toEqual({ name: 'Cat' });

    expect((await post(as.admin, `/api/v1/projects/${s.projectId}/restore`)).status).toBe(200);
    expect((await patch(as.admin, itemUrl(item.id), { version: 1, title: 'Now editable' })).status).toBe(200);
  });

  it('an archived workspace makes its projects read-only', async () => {
    const item = await createItem(s, s.users.admin.id, { title: 'X' });
    expect((await patch(as.owner, `/api/v1/workspaces/${s.workspace.id}`, { status: 'archived' })).status).toBe(200);
    const res = await patch(as.admin, itemUrl(item.id), { version: 1, title: 'y' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('READ_ONLY');
    expect((await get(as.member, itemUrl(item.id))).status).toBe(200);
    expect((await post(as.owner, `/api/v1/workspaces/${s.workspace.id}/projects`, { name: 'New project' })).status).toBe(409);
  });
});

describe('tag picker scope', () => {
  it('scope=all adds tags from archived items only for roles that can see archived content', async () => {
    const created = await post(as.admin, listUrl(), { type: 'external_link', title: 'Old', externalUrl: 'https://example.com/old', tags: ['legacy'] });
    expect(created.status).toBe(201);
    expect((await post(as.admin, `${itemUrl(created.body.id)}/archive`)).status).toBe(200);
    const names = (r: Res) => r.body.data.map((t: { name: string }) => t.name);
    expect(names(await get(as.admin, `/api/v1/projects/${s.projectId}/tags`))).not.toContain('legacy');
    expect(names(await get(as.admin, `/api/v1/projects/${s.projectId}/tags?scope=all`))).toContain('legacy');
    expect(names(await get(as.member, `/api/v1/projects/${s.projectId}/tags?scope=all`))).not.toContain('legacy');
  });
});
