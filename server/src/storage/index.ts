// Object storage behind one small interface, so the same upload flow runs on
// local disk in development and on any S3-compatible bucket in production
// (Cloudflare R2, MinIO, AWS S3). Objects are always private: browsers only
// ever get short-lived signed URLs, issued after an authorization check.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { hmac, safeEqual } from '../lib/crypto.js';

export interface UploadTarget {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface DownloadOptions {
  filename: string;
  /** Content type to serve; risky types are always forced to download. */
  contentType: string;
  disposition: 'attachment' | 'inline';
  ttlSeconds: number;
}

export interface StorageDriver {
  readonly kind: 'local' | 's3';
  /** Where the browser should PUT the bytes. */
  uploadTarget(fileId: string, key: string, ttlSeconds: number): Promise<UploadTarget>;
  /** Size of a stored object, or null if it isn't there. */
  sizeOf(key: string): Promise<number | null>;
  read(key: string): Promise<Buffer>;
  downloadUrl(fileId: string, key: string, opts: DownloadOptions): Promise<string>;
  remove(key: string): Promise<void>;
  /** Extra origin the browser must be allowed to talk to (for the CSP), if any. */
  readonly browserOrigin: string | null;
}

export const contentDisposition = (disposition: 'attachment' | 'inline', filename: string) =>
  `${disposition}; filename="${filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

const UPLOAD_CONTENT_TYPE = 'application/octet-stream';

// ───────────────────────── Local disk (development) ─────────────────────────

/** URL signatures for the local driver's own /api/v1/storage endpoints. */
export function signLocal(kind: 'upload' | 'download', fileId: string, ttlSeconds: number, extra = '') {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { exp, sig: hmac(`${kind}:${fileId}:${exp}:${extra}`), expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyLocal(kind: 'upload' | 'download', fileId: string, exp: string, sig: string, extra = '') {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now() / 1000) return false;
  return safeEqual(sig, hmac(`${kind}:${fileId}:${expNum}:${extra}`));
}

class LocalDriver implements StorageDriver {
  readonly kind = 'local' as const;
  readonly browserOrigin = null;
  private root = () => path.resolve(config.storageDir);

  path(key: string): string {
    const p = path.resolve(this.root(), key);
    if (!p.startsWith(this.root() + path.sep)) throw new Error('storage key escapes root');
    return p;
  }

  async uploadTarget(fileId: string, _key: string, ttlSeconds: number): Promise<UploadTarget> {
    const s = signLocal('upload', fileId, ttlSeconds);
    return {
      method: 'PUT',
      url: `/api/v1/storage/upload/${fileId}?exp=${s.exp}&sig=${s.sig}`,
      headers: { 'content-type': UPLOAD_CONTENT_TYPE },
      expiresAt: s.expiresAt,
    };
  }

  /** Used by the local upload endpoint; keys embed the file's own UUID so writes never collide (§12.3). */
  async write(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async sizeOf(key: string) {
    try {
      return (await stat(this.path(key))).size;
    } catch {
      return null;
    }
  }

  read(key: string) {
    return readFile(this.path(key));
  }

  async downloadUrl(fileId: string, _key: string, opts: DownloadOptions) {
    const s = signLocal('download', fileId, opts.ttlSeconds, opts.disposition);
    return `/api/v1/storage/download/${fileId}?exp=${s.exp}&sig=${s.sig}&d=${opts.disposition}`;
  }

  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}

// ───────────────────────── S3-compatible (R2, MinIO, AWS) ─────────────────────────

export type S3Settings = typeof config.storage.s3;

export class S3Driver implements StorageDriver {
  readonly kind = 's3' as const;
  readonly browserOrigin: string | null;
  private client: S3Client;
  private bucket: string;

  constructor(c: S3Settings = config.storage.s3) {
    const missing = (['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'] as const).filter((k) => !c[k]);
    if (missing.length) throw new Error(`STORAGE_DRIVER=s3 needs: ${missing.map((m) => `S3_${m.replace(/[A-Z]/g, (x) => `_${x}`).toUpperCase()}`).join(', ')}`);
    this.bucket = c.bucket;
    this.client = new S3Client({
      endpoint: c.endpoint,
      region: c.region,
      forcePathStyle: c.forcePathStyle,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
      // R2 doesn't support the SDK's newer default request checksums on presigned PUTs.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    const u = new URL(c.endpoint);
    // Virtual-host style puts the bucket in the hostname, which changes the origin the browser talks to.
    this.browserOrigin = c.forcePathStyle ? u.origin : `${u.protocol}//${this.bucket}.${u.host}`;
  }

  async uploadTarget(_fileId: string, key: string, ttlSeconds: number): Promise<UploadTarget> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: UPLOAD_CONTENT_TYPE }),
      { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type']) },
    );
    return { method: 'PUT', url, headers: { 'content-type': UPLOAD_CONTENT_TYPE }, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }

  async sizeOf(key: string) {
    try {
      const h = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return h.ContentLength ?? null;
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
      throw err;
    }
  }

  async read(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  async downloadUrl(_fileId: string, key: string, opts: DownloadOptions) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: contentDisposition(opts.disposition, opts.filename),
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: opts.ttlSeconds },
    );
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let driver: StorageDriver | null = null;
/** The configured driver (created on first use, so tests can set env first). */
export function storage(): StorageDriver {
  driver ??= config.storage.driver === 's3' ? new S3Driver() : new LocalDriver();
  return driver;
}
export const localStorage = () => storage() as LocalDriver;
