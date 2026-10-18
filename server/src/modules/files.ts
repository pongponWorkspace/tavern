// File uploads (FR-005, §12.3). Flow mirrors presigned object storage:
//   1. POST upload-init      → authorization + validation + quota, returns a short-lived signed PUT URL
//   2. PUT  storage/upload   → bytes land under a tenant-namespaced, non-guessable key
//   3. POST upload-complete  → re-checks membership, then queues the malware/content scan
//   4. GET  download-url     → only after an item-level access check AND a clean scan
// Storage is pluggable (src/storage): local disk in development, any private
// S3-compatible bucket (Cloudflare R2, MinIO, AWS) in production.

import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool, query, tx } from '../db/pool.js';
import { AppError, forbidden, invalid, notFound } from '../lib/errors.js';
import { contentDisposition, localStorage, storage, verifyLocal } from '../storage/index.js';
import { extensionOf, safeFilename } from '../lib/text.js';
import { parse, uuid } from '../lib/validate.js';
import { audit } from '../audit.js';
import { loadProjectAccess, requireProject, requireUser } from '../authz/context.js';
import { loadItemForUser } from './knowledge-access.js';

export async function removeStoredObject(key: string) {
  await storage().remove(key);
}

const PREVIEWABLE = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;

// ───────────────────────── Content scanner ─────────────────────────

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Detect a file's real type from its leading bytes. */
export function sniff(buf: Buffer): string {
  const head = buf.subarray(0, 16);
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => head[offset + i] === b);
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (starts([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buf.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (starts([0x4d, 0x5a]) || starts([0x7f, 0x45, 0x4c, 0x46]) ||
      [[0xfe, 0xed, 0xfa, 0xce], [0xce, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((s) => starts(s)) ||
      buf.subarray(0, 2).toString('latin1') === '#!') {
    return 'application/x-executable';
  }
  if (starts([0x50, 0x4b, 0x03, 0x04])) {
    const names = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString('latin1');
    if (names.includes('[Content_Types].xml')) {
      if (names.includes('word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (names.includes('xl/')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      if (names.includes('ppt/')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    }
    return 'application/zip';
  }
  const sample = buf.subarray(0, 8192);
  if (!sample.includes(0)) {
    try {
      // stream: a multi-byte character cut at the sample boundary is buffered, not treated as invalid.
      new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: sample.length < buf.length });
      return 'text/plain';
    } catch {
      /* not utf-8 */
    }
  }
  return 'application/octet-stream';
}

export type ScanResult = { status: 'clean' | 'quarantined'; mimeType: string | null; detail: string | null };

/**
 * Built-in scanner: signature check (EICAR), executable detection, and
 * content-vs-extension validation. A production deployment adds ClamAV or a
 * cloud scanner behind this same function.
 */
export function scanBuffer(buf: Buffer, filename: string): ScanResult {
  if (buf.includes(Buffer.from(EICAR, 'latin1'))) return { status: 'quarantined', mimeType: null, detail: 'Malware signature detected.' };
  const detected = sniff(buf);
  if (detected === 'application/x-executable') return { status: 'quarantined', mimeType: detected, detail: 'Executable content is not allowed.' };
  const ext = extensionOf(filename);
  const allowed = config.uploads.allowed[ext] ?? [];
  const textual = allowed.includes('text/plain');
  if (allowed.includes(detected)) return { status: 'clean', mimeType: textual ? allowed[0] : detected, detail: null };
  return { status: 'quarantined', mimeType: detected, detail: `File contents do not match the .${ext} extension.` };
}

const pendingScans = new Set<Promise<void>>();
/** Test helper: resolves when queued scans have finished. */
export const waitForScans = async () => {
  while (pendingScans.size) await Promise.all([...pendingScans]);
};

/** Background job — carries and re-validates its own tenant context (NFR-002). */
function enqueueScan(fileId: string, tenantId: string) {
  const job = (async () => {
    const file = await one(pool, `SELECT * FROM files WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [fileId, tenantId]);
    if (!file) return;
    let result: ScanResult;
    let checksum: string;
    try {
      const data = await storage().read(file.storage_key);
      checksum = createHash('sha256').update(data).digest('hex');
      result = scanBuffer(data, file.original_filename);
    } catch {
      // Scanner unavailable or object unreadable → stays unavailable (§11).
      await query(pool, `UPDATE files SET scan_status = 'failed', scan_detail = 'The file could not be scanned.' WHERE id = $1`, [fileId]);
      await audit(pool, null, { tenantId, projectId: file.project_id, action: 'file.scan_failed', targetType: 'file', targetId: fileId, outcome: 'failure' });
      return;
    }
    await query(pool, `UPDATE files SET scan_status = $2, mime_type = $3, scan_detail = $4, checksum_sha256 = coalesce(checksum_sha256, $5) WHERE id = $1`, [fileId, result.status, result.mimeType, result.detail, checksum]);
    await audit(pool, null, {
      tenantId, projectId: file.project_id, action: `file.scan_${result.status}`, targetType: 'file', targetId: fileId,
      outcome: result.status === 'clean' ? 'success' : 'denied', metadata: { filename: file.safe_filename, detectedType: result.mimeType },
    });
  })().catch(() => {});
  pendingScans.add(job);
  job.finally(() => pendingScans.delete(job));
}

/** Remove uploads that were never completed or never attached to an item. */
export async function cleanupOrphanFiles(olderThanHours = 24) {
  const rows = await query(
    pool,
    `UPDATE files f SET deleted_at = now()
      WHERE f.deleted_at IS NULL AND f.created_at < now() - make_interval(hours => $1)
        AND NOT EXISTS (SELECT 1 FROM knowledge_items k WHERE k.file_id = f.id)
      RETURNING storage_key`,
    [olderThanHours],
  );
  for (const r of rows) await removeStoredObject(r.storage_key).catch(() => {});
  return rows.length;
}

function fileStatus(f: any) {
  return {
    id: f.id,
    filename: f.safe_filename,
    size: f.size_bytes,
    mimeType: f.mime_type,
    uploadState: f.upload_state,
    scanStatus: f.scan_status,
    scanDetail: f.scan_detail,
  };
}

// ───────────────────────── Routes ─────────────────────────

export async function fileRoutes(app: FastifyInstance) {
  app.post('/projects/:projectId/files/upload-init', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = requireUser(req);
    const { projectId } = parse(z.object({ projectId: uuid }), req.params);
    const body = parse(
      z.object({ filename: z.string().min(1).max(255), size: z.number().int().min(1), mimeType: z.string().max(200).default('') }),
      req.body,
    );
    const filename = safeFilename(body.filename);
    const ext = extensionOf(filename);
    const allowed = config.uploads.allowed[ext];
    if (!allowed) {
      throw invalid(`filename: .${ext || '?'} files are not allowed. Allowed types: ${Object.keys(config.uploads.allowed).join(', ')}.`);
    }
    if (body.size > config.uploads.maxBytes) {
      throw invalid(`size: files must be ${Math.round(config.uploads.maxBytes / 1024 / 1024)} MB or smaller.`);
    }
    if (body.mimeType && body.mimeType !== 'application/octet-stream' && !allowed.includes(body.mimeType)) {
      throw invalid(`mimeType: ${body.mimeType} does not match a .${ext} file.`);
    }

    const result = await tx(async (db) => {
      const access = await requireProject(db, u.id, projectId, 'knowledge.create', { write: true });
      // Serialize quota checks per tenant so concurrent inits can't overshoot.
      await query(db, 'SELECT pg_advisory_xact_lock(hashtext($1))', [`quota:${access.tenantId}`]);
      const used = (await one(db, `SELECT coalesce(sum(size_bytes),0)::bigint AS n FROM files WHERE tenant_id = $1 AND deleted_at IS NULL`, [access.tenantId]))!.n;
      if (Number(used) + body.size > config.uploads.tenantQuotaBytes) {
        throw new AppError(422, 'QUOTA_EXCEEDED', 'Your organization has used its storage allowance. Remove unused files or ask an admin to raise the limit.');
      }
      // Ceiling across every organization (keeps the bucket inside its free tier). Taken after the
      // tenant lock, always in this order, so the two locks can't deadlock.
      await query(db, 'SELECT pg_advisory_xact_lock(hashtext($1))', ['quota:global']);
      const total = (await one(db, `SELECT coalesce(sum(size_bytes),0)::bigint AS n FROM files WHERE deleted_at IS NULL`))!.n;
      if (Number(total) + body.size > config.storage.totalLimitBytes) {
        throw new AppError(422, 'QUOTA_EXCEEDED', 'File storage for this service is full right now. Remove unused files or contact the administrator.');
      }
      const fileId = randomUUID();
      await query(
        db,
        `INSERT INTO files (id, tenant_id, project_id, storage_key, original_filename, safe_filename, declared_mime, size_bytes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [fileId, access.tenantId, access.projectId, `tenants/${access.tenantId}/projects/${access.projectId}/${fileId}`,
         body.filename.slice(0, 255), filename, body.mimeType || 'application/octet-stream', body.size, u.id],
      );
      return { fileId, key: `tenants/${access.tenantId}/projects/${access.projectId}/${fileId}` };
    });
    const upload = await storage().uploadTarget(result.fileId, result.key, config.uploads.uploadUrlTtlSeconds);
    return reply.status(201).send({ fileId: result.fileId, upload });
  });

  // Local driver only: raw-body endpoints authorized by URL signature, standing in for the bucket.
  if (storage().kind === 'local') await app.register(async (local) => {
    local.removeAllContentTypeParsers();
    local.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.uploads.maxBytes + 1 }, (_req, body, done) => done(null, body));

    local.put('/storage/upload/:fileId', async (req) => {
      const { fileId } = parse(z.object({ fileId: uuid }), req.params);
      const q = req.query as Record<string, string>;
      if (!verifyLocal('upload', fileId, q.exp ?? '', q.sig ?? '')) throw forbidden('This upload link is invalid or has expired.');
      const body = req.body;
      if (!Buffer.isBuffer(body)) throw invalid('Upload body is missing.');
      await tx(async (db) => {
        const file = await one(db, `SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [fileId]);
        if (!file || file.upload_state !== 'initiated') throw notFound('upload');
        if (body.length !== Number(file.size_bytes)) throw invalid(`The uploaded file is ${body.length} bytes but ${file.size_bytes} were expected.`);
        await localStorage().write(file.storage_key, body);
        await query(db, `UPDATE files SET upload_state = 'uploaded', checksum_sha256 = $2 WHERE id = $1`, [
          fileId,
          createHash('sha256').update(body).digest('hex'),
        ]);
      });
      return { ok: true };
    });

    local.get('/storage/download/:fileId', async (req, reply) => {
      const { fileId } = parse(z.object({ fileId: uuid }), req.params);
      const q = req.query as Record<string, string>;
      const disposition = q.d === 'inline' ? 'inline' : 'attachment';
      if (!verifyLocal('download', fileId, q.exp ?? '', q.sig ?? '', disposition)) throw forbidden('This download link is invalid or has expired.');
      const file = await one(pool, `SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL AND scan_status = 'clean'`, [fileId]);
      if (!file) throw notFound('file');
      const data = await localStorage().read(file.storage_key);
      const previewable = PREVIEWABLE.test(file.mime_type);
      reply
        .header('content-type', previewable ? file.mime_type : 'application/octet-stream')
        .header('content-disposition', contentDisposition(disposition === 'inline' && previewable ? 'inline' : 'attachment', file.safe_filename))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .header('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
      return reply.send(data);
    });
  });

  app.post('/files/:fileId/upload-complete', async (req) => {
    const u = requireUser(req);
    const { fileId } = parse(z.object({ fileId: uuid }), req.params);
    const file = await tx(async (db) => {
      const f = await one(db, `SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [fileId]);
      if (!f || f.uploaded_by !== u.id) throw notFound('upload');
      // Membership may have been revoked mid-upload — check again now (§11).
      await requireProject(db, u.id, f.project_id, 'knowledge.create', { write: true }).catch((e) => {
        throw e.status === 404 ? notFound('upload') : e;
      });
      if (f.upload_state === 'completed') return f; // idempotent retry (§11)
      if (f.upload_state === 'initiated') {
        // Direct-to-bucket uploads (S3/R2) never pass through the API: confirm the object is there
        // and exactly the declared size before accepting it. A mismatch is discarded.
        const size = await storage().sizeOf(f.storage_key);
        if (size === null) throw invalid('The file has not finished uploading.');
        if (size !== Number(f.size_bytes)) {
          await storage().remove(f.storage_key).catch(() => {});
          await query(db, `UPDATE files SET deleted_at = now() WHERE id = $1`, [fileId]);
          throw invalid(`The uploaded file is ${size} bytes but ${f.size_bytes} were declared. Upload it again.`);
        }
      } else if (f.upload_state !== 'uploaded') {
        throw invalid('The file has not finished uploading.');
      }
      const updated = await one(db, `UPDATE files SET upload_state = 'completed' WHERE id = $1 RETURNING *`, [fileId]);
      await audit(db, req, {
        tenantId: f.tenant_id, projectId: f.project_id, actorUserId: u.id, action: 'file.uploaded', targetType: 'file', targetId: fileId,
        metadata: { filename: f.safe_filename, size: Number(f.size_bytes) },
      });
      return updated;
    });
    if (file.scan_status === 'pending') enqueueScan(fileId, file.tenant_id);
    return fileStatus(file);
  });

  /** A file is readable by its uploader (before attachment) or by anyone who can view the item it belongs to. */
  async function loadReadableFile(userId: string, fileId: string) {
    const file = await one(pool, `SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL`, [fileId]);
    if (!file) throw notFound('file');
    const item = await one(pool, `SELECT id FROM knowledge_items WHERE file_id = $1 AND status <> 'deleted'`, [fileId]);
    if (item) {
      await loadItemForUser(pool, userId, item.id).catch(() => {
        throw notFound('file');
      });
    } else {
      if (file.uploaded_by !== userId) throw notFound('file');
      await loadProjectAccess(pool, userId, file.project_id).catch(() => {
        throw notFound('file');
      });
    }
    return file;
  }

  app.get('/files/:fileId/status', async (req) => {
    const u = requireUser(req);
    const { fileId } = parse(z.object({ fileId: uuid }), req.params);
    return fileStatus(await loadReadableFile(u.id, fileId));
  });

  app.get('/files/:fileId/download-url', async (req) => {
    const u = requireUser(req);
    const { fileId } = parse(z.object({ fileId: uuid }), req.params);
    const q = parse(z.object({ disposition: z.enum(['attachment', 'inline']).default('attachment') }), req.query);
    const file = await loadReadableFile(u.id, fileId);
    if (file.scan_status !== 'clean') {
      const reason =
        file.scan_status === 'pending' ? 'This file is still being checked. Try again in a moment.'
        : file.scan_status === 'quarantined' ? 'This file was blocked by the security scan and cannot be downloaded.'
        : 'This file could not be checked, so it is not available for download.';
      throw new AppError(409, 'FILE_NOT_AVAILABLE', reason, { scanStatus: file.scan_status });
    }
    const previewable = PREVIEWABLE.test(file.mime_type ?? '');
    const ttl = config.uploads.downloadUrlTtlSeconds;
    const url = await storage().downloadUrl(fileId, file.storage_key, {
      filename: file.safe_filename,
      // Only images and PDFs may render; everything else is forced to download as opaque bytes.
      contentType: previewable ? file.mime_type : 'application/octet-stream',
      disposition: q.disposition === 'inline' && previewable ? 'inline' : 'attachment',
      ttlSeconds: ttl,
    });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  });

  app.delete('/files/:fileId', async (req) => {
    const u = requireUser(req);
    const { fileId } = parse(z.object({ fileId: uuid }), req.params);
    const key = await tx(async (db) => {
      const f = await one(db, `SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [fileId]);
      if (!f) throw notFound('file');
      const access = await loadProjectAccess(db, u.id, f.project_id).catch(() => {
        throw notFound('file');
      });
      if (f.uploaded_by !== u.id && access.role !== 'project_admin') throw notFound('file');
      if (await one(db, `SELECT 1 FROM knowledge_items WHERE file_id = $1`, [fileId])) {
        throw new AppError(409, 'CONFLICT', 'This file is attached to a knowledge item. Delete the item instead.');
      }
      await query(db, 'UPDATE files SET deleted_at = now() WHERE id = $1', [fileId]);
      await audit(db, req, { tenantId: f.tenant_id, projectId: f.project_id, actorUserId: u.id, action: 'file.deleted', targetType: 'file', targetId: fileId });
      return f.storage_key as string;
    });
    await removeStoredObject(key).catch(() => {});
    return { ok: true };
  });
}

