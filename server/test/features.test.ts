// P1 features: document history, "view as" preview, CSV export/import,
// storage usage, admin attention list, onboarding due dates, project duplicate.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HIDDEN,
  count,
  createItem,
  get,
  loginAll,
  one,
  pool,
  post,
  put,
  query,
  seedProject,
  useTestApp,
  type Seed,
} from './helpers.js';

useTestApp();

let s: Seed;
let as: Awaited<ReturnType<typeof loginAll>>;
beforeEach(async () => {
  s = await seedProject('Feat');
  as = await loginAll(s.users);
});
const P = () => `/api/v1/projects/${s.projectId}`;

describe('document version history', () => {
  const newDoc = async (content = 'v1') =>
    (await post(as.maintainer, `${P()}/knowledge`, { type: 'internal_document', title: 'Guide', content })).body;

  it('records a version on create and on every changed save, newest first; unchanged saves add nothing', async () => {
    const doc = await newDoc('first');
    let v = doc.version;
    v = (await put(as.maintainer, `/api/v1/knowledge/${doc.id}/content`, { content: 'second', version: v })).body.version;
    const same = await put(as.maintainer, `/api/v1/knowledge/${doc.id}/content`, { content: 'second', version: v });
    expect(same.body.version).toBe(v);
    const list = await get(as.viewer, `/api/v1/knowledge/${doc.id}/revisions`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data[0].current).toBe(true);
    const oldest = await get(as.viewer, `/api/v1/knowledge/${doc.id}/revisions/${list.body.data[1].id}`);
    expect(oldest.body.content).toBe('first');
  });

  it('restore needs edit rights, writes a new version and is audited', async () => {
    const doc = await newDoc('original');
    const v2 = (await put(as.maintainer, `/api/v1/knowledge/${doc.id}/content`, { content: 'changed', version: doc.version })).body.version;
    const revs = (await get(as.maintainer, `/api/v1/knowledge/${doc.id}/revisions`)).body.data;
    const first = revs[revs.length - 1].id;
    expect((await post(as.viewer, `/api/v1/knowledge/${doc.id}/revisions/${first}/restore`, { version: v2 })).status).toBe(403);
    expect((await post(as.maintainer, `/api/v1/knowledge/${doc.id}/revisions/${first}/restore`, { version: 1 })).status).toBe(409);
    const ok = await post(as.maintainer, `/api/v1/knowledge/${doc.id}/revisions/${first}/restore`, { version: v2 });
    expect(ok.status).toBe(200);
    expect((await get(as.member, `/api/v1/knowledge/${doc.id}/content`)).body.content).toBe('original');
    const after = (await get(as.maintainer, `/api/v1/knowledge/${doc.id}/revisions`)).body.data;
    expect(after).toHaveLength(3);
    expect(after[0].restored).toBe(true);
    expect(await count(`SELECT count(*) FROM audit_logs WHERE action = 'knowledge.version_restored'`)).toBe(1);
  });

  it('history of a hidden document is as invisible as the document', async () => {
    const doc = await createItem(s, s.users.admin.id, { type: 'internal_document', title: 'Secret', content: 'x', rules: { member: HIDDEN } });
    expect((await get(as.member, `/api/v1/knowledge/${doc.id}/revisions`)).status).toBe(404);
  });

  it('keeps only the newest 50 versions', async () => {
    const doc = await newDoc('0');
    let v = doc.version;
    for (let i = 1; i <= 55; i++) v = (await put(as.maintainer, `/api/v1/knowledge/${doc.id}/content`, { content: String(i), version: v })).body.version;
    expect(await count(`SELECT count(*) FROM knowledge_document_revisions WHERE knowledge_item_id = $1`, [doc.id])).toBe(50);
  });
});

describe('view as another role (preview)', () => {
  it('a Project Admin sees exactly what the previewed role sees', async () => {
    await createItem(s, s.users.admin.id, { title: 'Admins only', rules: { member: HIDDEN, viewer: HIDDEN } });
    await createItem(s, s.users.admin.id, { title: 'Everyone' });
    const asViewer = await get(as.admin, `${P()}/knowledge`, { headers: { 'x-preview-role': 'viewer' } });
    expect(asViewer.body.data.map((i: { title: string }) => i.title)).toEqual(['Everyone']);
    expect(asViewer.body.data[0].permissions.edit).toBe(false);
    const proj = await get(as.admin, P(), { headers: { 'x-preview-role': 'member' } });
    expect(proj.body).toMatchObject({ myRole: 'member', actualRole: 'project_admin', previewing: true });
    expect((await get(as.admin, `${P()}/members`, { headers: { 'x-preview-role': 'viewer' } })).status).toBe(403);
  });

  it('refuses changes while previewing, and only admins can preview', async () => {
    const r = await post(as.admin, `${P()}/knowledge`, { type: 'external_link', title: 'x', externalUrl: 'https://example.com/p' }, { headers: { 'x-preview-role': 'member' } });
    expect(r.status).toBe(409);
    const asMember = await get(as.member, P(), { headers: { 'x-preview-role': 'viewer' } });
    expect(asMember.body).toMatchObject({ myRole: 'member', previewing: false });
    const bogus = await get(as.admin, P(), { headers: { 'x-preview-role': 'project_admin' } });
    expect(bogus.body.previewing).toBe(false);
  });
});

describe('audit log CSV export', () => {
  it('Project Admins export filtered activity as CSV; others cannot', async () => {
    await post(as.admin, `${P()}/knowledge`, { type: 'external_link', title: '=HYPERLINK("x")', externalUrl: 'https://example.com/csv' });
    const res = await get(as.admin, `${P()}/audit-logs/export?action=knowledge.`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="activity-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('When (UTC),Who,Action,Target,Outcome,Details,Request ID');
    expect(lines.some((l) => l.includes('knowledge.created'))).toBe(true);
    expect(res.text).toContain(`"'=HYPERLINK(""x"")"`); // formula neutralized
    expect((await get(as.maintainer, `${P()}/audit-logs/export`)).status).toBe(403);
    expect(await count(`SELECT count(*) FROM audit_logs WHERE action = 'audit.exported'`)).toBe(1);
  });
});

describe('link import and export (CSV)', () => {
  it('exports only links the caller can see', async () => {
    await createItem(s, s.users.admin.id, { title: 'Visible link', url: 'https://example.com/visible' });
    await createItem(s, s.users.admin.id, { title: 'Hidden link', url: 'https://example.com/hidden', rules: { member: HIDDEN } });
    const res = await get(as.member, `${P()}/knowledge/export`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Visible link');
    expect(res.text).not.toContain('Hidden link');
  });

  it('imports rows, creates categories for roles that may, and reports what it skipped', async () => {
    await createItem(s, s.users.admin.id, { title: 'Existing', url: 'https://example.com/existing' });
    const csv = [
      'Title,URL,Description,Category,Tags',
      'Figma,https://figma.com/file/abc,Design file,Design,"design, ui"',
      'Repo,https://github.com/acme/repo,,Engineering,code',
      ',https://example.com/no-title,,,',
      'Bad,javascript:alert(1),,,',
      'Again,https://example.com/existing,,,',
      'Dup in file,https://figma.com/file/abc/,,,',
    ].join('\n');
    const res = await post(as.maintainer, `${P()}/knowledge/import`, { csv });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.skipped.map((x: { row: number; reason: string }) => [x.row, x.reason])).toEqual([
      [4, 'No title'], [5, 'Not a valid http(s) link'], [6, 'Already in this project'], [7, 'Already in this project'],
    ]);
    expect(await count(`SELECT count(*) FROM knowledge_categories WHERE project_id = $1 AND name IN ('Design','Engineering')`, [s.projectId])).toBe(2);
    const figma = await one(pool, `SELECT ki.id, c.name AS cat FROM knowledge_items ki LEFT JOIN knowledge_categories c ON c.id = ki.category_id WHERE ki.title = 'Figma'`);
    expect(figma.cat).toBe('Design');
    expect(await count(`SELECT count(*) FROM knowledge_item_tags WHERE knowledge_item_id = $1`, [figma.id])).toBe(2);
  });

  it('members import without creating categories; viewers cannot import', async () => {
    const csv = 'title,url,category\nThing,https://example.com/thing,Brand new';
    const res = await post(as.member, `${P()}/knowledge/import`, { csv });
    expect(res.body.created).toBe(1);
    expect(await count(`SELECT count(*) FROM knowledge_categories WHERE project_id = $1`, [s.projectId])).toBe(0);
    expect((await post(as.viewer, `${P()}/knowledge/import`, { csv })).status).toBe(403);
  });
});

describe('storage usage', () => {
  it('shows organization totals and per-project usage to settings readers only', async () => {
    await query(pool, `INSERT INTO files (tenant_id, project_id, storage_key, original_filename, safe_filename, declared_mime, size_bytes, uploaded_by)
                       VALUES ($1,$2,'k1','a.pdf','a.pdf','application/pdf',1000,$3), ($1,$2,'k2','b.pdf','b.pdf','application/pdf',500,$3)`,
      [s.tenantId, s.projectId, s.users.admin.id]);
    const res = await get(as.owner, `/api/v1/tenants/${s.tenantId}/storage`);
    expect(res.body).toMatchObject({ used: 1500, files: 2, byProject: [{ id: s.projectId, used: 1500, files: 2 }] });
    expect((await get(as.outsider, `/api/v1/tenants/${s.tenantId}/storage`)).status).toBe(403);
  });
});

describe('needs attention (Project Admins)', () => {
  it('lists invitations expiring within 48 hours and blocked files', async () => {
    const soon = await post(as.admin, `${P()}/invitations`, { role: 'viewer', expiresInDays: 1 });
    await post(as.admin, `${P()}/invitations`, { role: 'viewer', expiresInDays: 7 });
    await query(pool, `INSERT INTO files (tenant_id, project_id, storage_key, original_filename, safe_filename, declared_mime, size_bytes, uploaded_by, upload_state, scan_status)
                       VALUES ($1,$2,'k3','v.txt','v.txt','text/plain',10,$3,'completed','quarantined')`, [s.tenantId, s.projectId, s.users.admin.id]);
    const res = await get(as.admin, `${P()}/attention`);
    expect(res.body.expiringInvitations.map((i: { id: string }) => i.id)).toEqual([soon.body.invitation.id]);
    expect(res.body.blockedFiles).toHaveLength(1);
    expect((await get(as.maintainer, `${P()}/attention`)).status).toBe(403);
  });
});

describe('onboarding due dates', () => {
  it('computes due dates from the join date and reports overdue steps', async () => {
    const t = await post(as.admin, `${P()}/onboarding/templates`, { name: 'Start' });
    await post(as.admin, `/api/v1/onboarding/templates/${t.body.id}/steps`, { title: 'Read the guide', dueDays: 3 });
    await post(as.admin, `/api/v1/onboarding/templates/${t.body.id}/steps`, { title: 'No deadline' });
    expect((await post(as.admin, `/api/v1/onboarding/templates/${t.body.id}/steps`, { title: 'Bad', dueDays: 0 })).status).toBe(422);
    await query(pool, `UPDATE project_memberships SET joined_at = now() - interval '10 days' WHERE user_id = $1`, [s.users.member.id]);

    const mine = (await get(as.member, `${P()}/onboarding`)).body.templates[0].steps;
    const guide = mine.find((x: { title: string }) => x.title === 'Read the guide');
    expect(guide.overdue).toBe(true);
    expect(mine.find((x: { title: string }) => x.title === 'No deadline').dueAt).toBeNull();

    const report = (await get(as.admin, `${P()}/onboarding/report`)).body.data;
    expect(report.find((r: { userId: string }) => r.userId === s.users.member.id).overdue).toBe(1);
    await post(as.member, `/api/v1/onboarding/steps/${guide.id}/complete`, { completed: true });
    const after = (await get(as.admin, `${P()}/onboarding/report`)).body.data;
    expect(after.find((r: { userId: string }) => r.userId === s.users.member.id).overdue).toBe(0);
  });
});

describe('duplicate project', () => {
  it('copies structure and visible content, not members or files; needs project create rights', async () => {
    const cat = await post(as.admin, `${P()}/categories`, { name: 'Design' });
    const link = await post(as.admin, `${P()}/knowledge`, { type: 'external_link', title: 'Figma', externalUrl: 'https://figma.com/x', categoryId: cat.body.id, tags: ['ui'], isPinned: true, visibilityRoles: ['project_admin', 'maintainer'] });
    await post(as.admin, `${P()}/knowledge`, { type: 'internal_document', title: 'Guide', content: '# Hello' });
    const t = await post(as.admin, `${P()}/onboarding/templates`, { name: 'Start' });
    await post(as.admin, `/api/v1/onboarding/templates/${t.body.id}/steps`, { title: 'Open Figma', knowledgeItemId: link.body.id, dueDays: 5 });
    await put(as.admin, `${P()}/role-permissions`, { permissions: { member: { create: false } } });

    // The project admin is a plain tenant member: not allowed to create projects.
    expect((await post(as.admin, `${P()}/duplicate`, { name: 'Copy' })).status).toBe(403);
    await query(pool, `UPDATE tenant_memberships SET role = 'admin' WHERE user_id = $1`, [s.users.admin.id]);

    const res = await post(as.admin, `${P()}/duplicate`, { name: 'Copy' });
    expect(res.status).toBe(201);
    const id = res.body.id;
    expect(await count(`SELECT count(*) FROM project_memberships WHERE project_id = $1`, [id])).toBe(1);
    expect(await count(`SELECT count(*) FROM knowledge_items WHERE project_id = $1`, [id])).toBe(2);
    const copied = await one(pool, `SELECT ki.id, ki.is_pinned, c.name AS cat FROM knowledge_items ki JOIN knowledge_categories c ON c.id = ki.category_id WHERE ki.project_id = $1 AND ki.title = 'Figma'`, [id]);
    expect(copied).toMatchObject({ is_pinned: true, cat: 'Design' });
    expect(await count(`SELECT count(*) FROM knowledge_item_access_rules WHERE knowledge_item_id = $1 AND NOT can_view`, [copied.id])).toBe(2);
    const step = await one(pool, `SELECT knowledge_item_id, due_days FROM onboarding_steps WHERE project_id = $1`, [id]);
    expect(step).toEqual({ knowledge_item_id: copied.id, due_days: 5 });
    const perms = await one(pool, `SELECT role_permissions FROM projects WHERE id = $1`, [id]);
    expect(perms.role_permissions.member.create).toBe(false);

    const structureOnly = await post(as.admin, `${P()}/duplicate`, { name: 'Empty copy', includeContent: false });
    expect(await count(`SELECT count(*) FROM knowledge_items WHERE project_id = $1`, [structureOnly.body.id])).toBe(0);
    expect(await count(`SELECT count(*) FROM onboarding_steps WHERE project_id = $1 AND knowledge_item_id IS NULL`, [structureOnly.body.id])).toBe(1);
    expect((await post(as.maintainer, `${P()}/duplicate`, { name: 'Nope' })).status).toBe(403);
  });
});

describe('storage ceiling', () => {
  it('refuses uploads once the whole service reaches its limit, even for an organization with room left', async () => {
    const other = await seedProject('Other');
    await query(pool, `INSERT INTO files (tenant_id, project_id, storage_key, original_filename, safe_filename, declared_mime, size_bytes, uploaded_by)
                       VALUES ($1,$2,'huge','h.pdf','h.pdf','application/pdf',$3,$4)`, [other.tenantId, other.projectId, 9 * 1024 ** 3 - 10, other.users.admin.id]);
    const res = await post(as.admin, `${P()}/files/upload-init`, { filename: 'a.pdf', size: 100, mimeType: 'application/pdf' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('storage for this service is full');
    expect((await post(as.admin, `${P()}/files/upload-init`, { filename: 'a.pdf', size: 5, mimeType: 'application/pdf' })).status).toBe(201);
  });
});
