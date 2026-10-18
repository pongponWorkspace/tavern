// File uploads: AC-009 quarantine / pending, AC-015 upload validation, signed
// URL integrity, and membership re-checks during the upload flow.
import { beforeEach, describe, expect, it } from 'vitest';
import { hmac } from '../src/lib/crypto.js';
import {
  call,
  count,
  createFile,
  createItem,
  del,
  get,
  loginAll,
  one,
  pool,
  post,
  query,
  seedProject,
  useTestApp,
  waitForScans,
  type Seed,
  type Session,
} from './helpers.js';

useTestApp();

const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS', '-TEST-FILE!$H+H*'].join('');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const MZ = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62, 0)]);
const MAX_BYTES = 25 * 1024 * 1024;

let s: Seed;
let as: Awaited<ReturnType<typeof loginAll>>;

beforeEach(async () => {
  s = await seedProject('Alpha');
  as = await loginAll(s.users);
});

const initUrl = () => `/api/v1/projects/${s.projectId}/files/upload-init`;

async function init(u: Session, filename: string, bytes: Buffer, mimeType?: string) {
  return post(u, initUrl(), { filename, size: bytes.length, ...(mimeType ? { mimeType } : {}) });
}

/** PUT raw bytes to the signed storage URL the way a browser would. */
function putBytes(url: string, bytes: Buffer, extraHeaders: Record<string, string> = {}) {
  return call('PUT', url, { rawBody: bytes, headers: { 'content-type': 'application/octet-stream', ...extraHeaders } });
}

/** init → PUT → complete → scan, returning the file id. */
async function upload(u: Session, filename: string, bytes: Buffer, mimeType?: string) {
  const i = await init(u, filename, bytes, mimeType);
  expect(i.status, i.text).toBe(201);
  expect(i.body.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/octet-stream' } });
  const p = await putBytes(i.body.upload.url, bytes);
  expect(p.status, p.text).toBe(200);
  const c = await post(u, `/api/v1/files/${i.body.fileId}/upload-complete`);
  expect(c.status, c.text).toBe(200);
  expect(c.body).toMatchObject({ id: i.body.fileId, uploadState: 'completed' });
  await waitForScans();
  return i.body.fileId as string;
}

describe('AC-009 full upload flow', () => {
  it('upload → scan clean → attach → signed download returns the exact bytes', async () => {
    const fileId = await upload(as.member, 'Quarterly Report.pdf', PDF, 'application/pdf');
    const status = await get(as.member, `/api/v1/files/${fileId}/status`);
    expect(status.body).toMatchObject({ scanStatus: 'clean', mimeType: 'application/pdf', filename: 'Quarterly Report.pdf', size: PDF.length });

    const item = await post(as.member, `/api/v1/projects/${s.projectId}/knowledge`, { type: 'uploaded_file', title: 'Q report', fileId });
    expect(item.status, item.text).toBe(201);
    expect(item.body.file).toMatchObject({ id: fileId, scanStatus: 'clean' });

    // Anyone who can view the item can download it; the URL is short-lived and signed.
    for (const u of [as.member, as.viewer, as.admin]) {
      const dl = await get(u, `/api/v1/files/${fileId}/download-url`);
      expect(dl.status).toBe(200);
      expect(dl.body.url).toMatch(new RegExp(`^/api/v1/storage/download/${fileId}\\?exp=\\d+&sig=[\\w-]+&d=attachment$`));
      expect(new Date(dl.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(61_000);
      const bytes = await call('GET', dl.body.url);
      expect(bytes.status).toBe(200);
      expect(Buffer.compare(bytes.rawPayload, PDF)).toBe(0);
      expect(bytes.headers['content-type']).toBe('application/pdf');
      expect(bytes.headers['content-disposition']).toMatch(/^attachment; filename="Quarterly Report.pdf"/);
      expect(bytes.headers['x-content-type-options']).toBe('nosniff');
      expect(bytes.headers['cache-control']).toBe('private, no-store');
    }
    // Non-members never get a URL.
    for (const u of [as.outsider, as.owner, as.tenantAdmin]) {
      expect((await get(u, `/api/v1/files/${fileId}/download-url`)).status).toBe(404);
    }
    // Stored object key is tenant/project namespaced and not derived from the filename.
    const row = await one(pool, 'SELECT storage_key, checksum_sha256 FROM files WHERE id = $1', [fileId]);
    expect(row.storage_key).toBe(`tenants/${s.tenantId}/projects/${s.projectId}/${fileId}`);
    expect(row.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts uploads larger than the 2 MB JSON body limit', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024, 0x20)]);
    const fileId = await upload(as.admin, 'big.pdf', big);
    await createItem(s, s.users.admin.id, { type: 'uploaded_file', fileId, title: 'Big' });
    const dl = await get(as.admin, `/api/v1/files/${fileId}/download-url`);
    expect(dl.status).toBe(200);
    const res = await call('GET', dl.body.url);
    expect(res.rawPayload.length).toBe(big.length);
  });

  it('inline disposition is only honoured for previewable types', async () => {
    const fileId = await upload(as.admin, 'pic.png', PNG);
    await createItem(s, s.users.admin.id, { type: 'uploaded_file', fileId, title: 'Pic' });
    const dl = await get(as.viewer, `/api/v1/files/${fileId}/download-url?disposition=inline`);
    const res = await call('GET', dl.body.url);
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.headers['content-security-policy']).toContain('sandbox');

    const md = await upload(as.admin, 'notes.md', Buffer.from('# hi\n'));
    await createItem(s, s.users.admin.id, { type: 'uploaded_file', fileId: md, title: 'Notes' });
    const dl2 = await get(as.viewer, `/api/v1/files/${md}/download-url?disposition=inline`);
    const res2 = await call('GET', dl2.body.url);
    expect(res2.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res2.headers['content-type']).toBe('application/octet-stream');
  });

  it('restricted item: file inherits the item visibility', async () => {
    const fileId = await upload(as.admin, 'secret.pdf', PDF);
    const item = await post(as.admin, `/api/v1/projects/${s.projectId}/knowledge`, {
      type: 'uploaded_file', title: 'Secret file', fileId, visibilityRoles: ['project_admin', 'maintainer'],
    });
    expect(item.status).toBe(201);
    expect((await get(as.member, `/api/v1/files/${fileId}/download-url`)).status).toBe(404);
    expect((await get(as.member, `/api/v1/files/${fileId}/status`)).status).toBe(404);
    expect((await get(as.maintainer, `/api/v1/files/${fileId}/download-url`)).status).toBe(200);
  });
});

describe('AC-009 pending / quarantined / failed files are never downloadable', () => {
  it('EICAR content in a .txt is quarantined → download-url 409 FILE_NOT_AVAILABLE', async () => {
    const fileId = await upload(as.member, 'notes.txt', Buffer.from(EICAR, 'latin1'));
    expect((await get(as.member, `/api/v1/files/${fileId}/status`)).body.scanStatus).toBe('quarantined');
    const res = await get(as.member, `/api/v1/files/${fileId}/download-url`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'FILE_NOT_AVAILABLE', details: { scanStatus: 'quarantined' } });
    expect(res.text).not.toContain('/storage/download');
    expect(await one(pool, `SELECT outcome FROM audit_logs WHERE action = 'file.scan_quarantined'`)).toEqual({ outcome: 'denied' });
  });

  it.each([
    ['executable bytes named .pdf', 'invoice.pdf', MZ],
    ['PNG bytes named .pdf', 'report.pdf', PNG],
  ])('%s is quarantined', async (_label, name, bytes) => {
    const fileId = await upload(as.member, name, bytes);
    expect((await get(as.member, `/api/v1/files/${fileId}/status`)).body.scanStatus).toBe('quarantined');
    expect((await get(as.member, `/api/v1/files/${fileId}/download-url`)).status).toBe(409);
  });

  it.each(['pending', 'failed', 'quarantined'] as const)('%s file attached to an item → 409, no URL issued', async (scanStatus) => {
    const file = await createFile(s, s.users.admin.id, { scanStatus });
    await createItem(s, s.users.admin.id, { type: 'uploaded_file', fileId: file.id, title: 'F' });
    for (const u of [as.admin, as.viewer]) {
      const res = await get(u, `/api/v1/files/${file.id}/download-url`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'FILE_NOT_AVAILABLE', details: { scanStatus } });
      expect(res.body.url).toBeUndefined();
    }
  });

  it('a correctly signed storage URL still refuses a non-clean file', async () => {
    const file = await createFile(s, s.users.admin.id, { scanStatus: 'quarantined' });
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = hmac(`download:${file.id}:${exp}:attachment`);
    const res = await call('GET', `/api/v1/storage/download/${file.id}?exp=${exp}&sig=${sig}&d=attachment`);
    expect(res.status).toBe(404);
  });
});

describe('AC-015 upload validation', () => {
  it.each(['malware.exe', 'page.html', 'page.htm', 'logo.svg', 'script.js', 'noextension', 'archive.zip', 'report.pdf.exe'])(
    'rejects %s with 422 and creates no files row',
    async (filename) => {
      const res = await post(as.member, initUrl(), { filename, size: 100 });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/not allowed/);
      expect(await count('SELECT count(*) FROM files')).toBe(0);
    },
  );

  it('rejects oversize files with 422 and creates no files row', async () => {
    const res = await post(as.member, initUrl(), { filename: 'big.pdf', size: MAX_BYTES + 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/25 MB/);
    expect(await count('SELECT count(*) FROM files')).toBe(0);
    expect((await post(as.member, initUrl(), { filename: 'max.pdf', size: MAX_BYTES })).status).toBe(201);
  });

  it('rejects a declared MIME type that does not match the extension', async () => {
    const res = await post(as.member, initUrl(), { filename: 'report.pdf', size: 10, mimeType: 'text/html' });
    expect(res.status).toBe(422);
    expect(await count('SELECT count(*) FROM files')).toBe(0);
  });

  it('rejects zero / negative sizes', async () => {
    expect((await post(as.member, initUrl(), { filename: 'a.pdf', size: 0 })).status).toBe(422);
    expect((await post(as.member, initUrl(), { filename: 'a.pdf', size: -5 })).status).toBe(422);
    expect(await count('SELECT count(*) FROM files')).toBe(0);
  });

  it('path-traversal filenames are reduced to a safe name', async () => {
    const i = await post(as.member, initUrl(), { filename: '../../../etc/passwd.txt', size: 4 });
    expect(i.status).toBe(201);
    const row = await one(pool, 'SELECT safe_filename, storage_key FROM files WHERE id = $1', [i.body.fileId]);
    expect(row.safe_filename).toBe('passwd.txt');
    expect(row.storage_key).not.toContain('..');
  });

  it('uploaded body size must match the declared size', async () => {
    const i = await init(as.member, 'a.pdf', PDF);
    const res = await putBytes(i.body.upload.url, Buffer.concat([PDF, Buffer.from('extra')]));
    expect(res.status).toBe(422);
    expect(await one(pool, 'SELECT upload_state FROM files WHERE id = $1', [i.body.fileId])).toEqual({ upload_state: 'initiated' });
  });

  it('viewer cannot start an upload', async () => {
    expect((await post(as.viewer, initUrl(), { filename: 'a.pdf', size: 10 })).status).toBe(403);
    expect(await count('SELECT count(*) FROM files')).toBe(0);
  });

  it('storage quota exceeded → 422 QUOTA_EXCEEDED before a usable upload path exists', async () => {
    await createFile(s, s.users.admin.id, { size: 2 * 1024 * 1024 * 1024 - 50 });
    const res = await post(as.member, initUrl(), { filename: 'a.pdf', size: 100 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.upload).toBeUndefined();
    expect(await count('SELECT count(*) FROM files')).toBe(1);
  });
});

describe('signed URL integrity', () => {
  it('tampered or expired upload signatures → 403 and nothing is stored', async () => {
    const i = await init(as.member, 'a.pdf', PDF);
    const url = new URL(i.body.upload.url, 'http://x');
    const fileId = i.body.fileId;

    const tampered = new URL(url);
    tampered.searchParams.set('sig', url.searchParams.get('sig')!.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')));
    expect((await putBytes(tampered.pathname + tampered.search, PDF)).status).toBe(403);

    const longer = new URL(url);
    longer.searchParams.set('exp', String(Number(url.searchParams.get('exp')) + 3600));
    expect((await putBytes(longer.pathname + longer.search, PDF)).status).toBe(403);

    const past = Math.floor(Date.now() / 1000) - 10;
    expect((await putBytes(`/api/v1/storage/upload/${fileId}?exp=${past}&sig=${hmac(`upload:${fileId}:${past}:`)}`, PDF)).status).toBe(403);

    // A signature for one file does not authorize another.
    const other = await init(as.member, 'b.pdf', PDF);
    expect((await putBytes(`/api/v1/storage/upload/${other.body.fileId}${url.search}`, PDF)).status).toBe(403);
    // Missing signature entirely.
    expect((await putBytes(`/api/v1/storage/upload/${fileId}`, PDF)).status).toBe(403);
    // Download signatures are not upload signatures.
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect((await putBytes(`/api/v1/storage/upload/${fileId}?exp=${exp}&sig=${hmac(`download:${fileId}:${exp}:`)}`, PDF)).status).toBe(403);

    expect(await one(pool, 'SELECT upload_state, checksum_sha256 FROM files WHERE id = $1', [fileId])).toEqual({ upload_state: 'initiated', checksum_sha256: null });
    // The genuine URL still works, once.
    expect((await putBytes(i.body.upload.url, PDF)).status).toBe(200);
    expect((await putBytes(i.body.upload.url, PDF)).status).toBe(404);
  });

  it('tampered, expired or disposition-swapped download signatures → 403', async () => {
    const fileId = await upload(as.admin, 'a.pdf', PDF);
    await createItem(s, s.users.admin.id, { type: 'uploaded_file', fileId, title: 'A' });
    const dl = await get(as.admin, `/api/v1/files/${fileId}/download-url`);
    const url = new URL(dl.body.url, 'http://x');

    const bad = new URL(url);
    bad.searchParams.set('sig', 'A'.repeat(43));
    expect((await call('GET', bad.pathname + bad.search)).status).toBe(403);

    const inline = new URL(url);
    inline.searchParams.set('d', 'inline');
    expect((await call('GET', inline.pathname + inline.search)).status).toBe(403);

    const past = Math.floor(Date.now() / 1000) - 1;
    expect((await call('GET', `/api/v1/storage/download/${fileId}?exp=${past}&sig=${hmac(`download:${fileId}:${past}:attachment`)}&d=attachment`)).status).toBe(403);

    const res = await call('GET', dl.body.url);
    expect(res.status).toBe(200);
  });
});

describe('membership re-checks during upload', () => {
  it('uploader removed from the project before upload-complete → 404, file not completed', async () => {
    const i = await init(as.member, 'a.pdf', PDF);
    expect((await putBytes(i.body.upload.url, PDF)).status).toBe(200);
    expect((await del(as.admin, `/api/v1/projects/${s.projectId}/members/${s.users.member.id}`)).status).toBe(200);
    const res = await post(as.member, `/api/v1/files/${i.body.fileId}/upload-complete`);
    expect(res.status).toBe(404);
    expect(await one(pool, 'SELECT upload_state, scan_status FROM files WHERE id = $1', [i.body.fileId])).toEqual({ upload_state: 'uploaded', scan_status: 'pending' });
    expect((await get(as.member, `/api/v1/files/${i.body.fileId}/status`)).status).toBe(404);
  });

  it('uploader demoted to viewer before upload-complete → 403', async () => {
    const i = await init(as.member, 'a.pdf', PDF);
    await putBytes(i.body.upload.url, PDF);
    await query(pool, `UPDATE project_memberships SET role = 'viewer' WHERE user_id = $1`, [s.users.member.id]);
    expect((await post(as.member, `/api/v1/files/${i.body.fileId}/upload-complete`)).status).toBe(403);
  });

  it("another user cannot complete, inspect, attach or delete someone else's upload", async () => {
    const fileId = await upload(as.member, 'a.pdf', PDF);
    expect((await post(as.maintainer, `/api/v1/files/${fileId}/upload-complete`)).status).toBe(404);
    expect((await get(as.maintainer, `/api/v1/files/${fileId}/status`)).status).toBe(404);
    expect((await get(as.maintainer, `/api/v1/files/${fileId}/download-url`)).status).toBe(404);
    expect((await del(as.maintainer, `/api/v1/files/${fileId}`)).status).toBe(404);
    const attach = await post(as.maintainer, `/api/v1/projects/${s.projectId}/knowledge`, { type: 'uploaded_file', title: 'Mine now', fileId });
    expect(attach.status).toBe(422);
    expect(await count(`SELECT count(*) FROM knowledge_items WHERE file_id = $1`, [fileId])).toBe(0);
  });

  it('upload-complete is idempotent and a file cannot be attached twice', async () => {
    const fileId = await upload(as.admin, 'a.pdf', PDF);
    const again = await post(as.admin, `/api/v1/files/${fileId}/upload-complete`);
    expect(again.status).toBe(200);
    expect(again.body.scanStatus).toBe('clean');
    expect((await post(as.admin, `/api/v1/projects/${s.projectId}/knowledge`, { type: 'uploaded_file', title: 'One', fileId })).status).toBe(201);
    expect((await post(as.admin, `/api/v1/projects/${s.projectId}/knowledge`, { type: 'uploaded_file', title: 'Two', fileId })).status).toBe(422);
    expect((await del(as.admin, `/api/v1/files/${fileId}`)).status).toBe(409);
  });

  it('upload-complete before the bytes arrive is rejected', async () => {
    const i = await init(as.member, 'a.pdf', PDF);
    expect((await post(as.member, `/api/v1/files/${i.body.fileId}/upload-complete`)).status).toBe(422);
  });
});
