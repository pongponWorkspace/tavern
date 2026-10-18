// S3 driver against a real S3-compatible server. Runs only when one is configured:
//   docker compose --profile s3 up -d s3
//   S3_TEST_ENDPOINT=http://localhost:9100 npm test
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { S3Driver } from '../src/storage/index.js';

const endpoint = process.env.S3_TEST_ENDPOINT;

describe.skipIf(!endpoint)('S3 storage driver (S3_TEST_ENDPOINT)', () => {
  // Built lazily: describe bodies run even when the suite is skipped.
  let cached: S3Driver | null = null;
  const driver = () => (cached ??= new S3Driver({
    endpoint: endpoint ?? '',
    region: 'auto',
    bucket: process.env.S3_TEST_BUCKET ?? 'tavern-files',
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'test',
    forcePathStyle: (process.env.S3_TEST_FORCE_PATH_STYLE ?? 'true') === 'true',
  }));

  it('upload by signed PUT, verify size, read, sign a download, delete', async () => {
    const id = randomUUID();
    const key = `tenants/test/projects/test/${id}`;
    const body = Buffer.from('# Notes\n\nสวัสดี — signed upload test\n');

    const target = await driver().uploadTarget(id, key, 120);
    expect(target.url).toMatch(/X-Amz-Signature=/);
    const put = await fetch(target.url, { method: 'PUT', headers: target.headers, body });
    expect(put.status).toBe(200);

    expect(await driver().sizeOf(key)).toBe(body.length);
    expect(Buffer.compare(await driver().read(key), body)).toBe(0);

    const url = await driver().downloadUrl(id, key, { filename: 'notes ไทย.md', contentType: 'application/octet-stream', disposition: 'attachment', ttlSeconds: 60 });
    const get = await fetch(url);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-disposition')).toContain("filename*=UTF-8''notes%20%E0%B9%84%E0%B8%97%E0%B8%A2.md");
    expect(get.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(await get.arrayBuffer()).toString()).toBe(body.toString());

    await driver().remove(key);
    expect(await driver().sizeOf(key)).toBeNull();
  });

  it('reports a missing object as null instead of throwing', async () => {
    expect(await driver().sizeOf(`tenants/test/missing/${randomUUID()}`)).toBeNull();
  });
});
