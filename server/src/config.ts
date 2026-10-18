// Central runtime configuration. Values marked "Needs approval" in spec §18 are
// configurable here rather than hard-coded as permanent product rules (§19.10).

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd,
  isTest,
  port: Number(env('PORT', '4000')),
  appOrigin: env('APP_ORIGIN', 'http://localhost:5173'),
  /** App traffic. On Neon this is the pooled (-pooler) endpoint. */
  databaseUrl: env('DATABASE_URL', 'postgres://tavern:tavern@localhost:54329/tavern'),
  /** Schema migrations. Neon recommends a direct (unpooled) connection for DDL; falls back to DATABASE_URL. */
  databaseUrlDirect: process.env.DATABASE_URL_UNPOOLED || env('DATABASE_URL', 'postgres://tavern:tavern@localhost:54329/tavern'),
  /** Set by `neon env pull` / `neon checkout`; used to keep demo data off production. */
  neonBranch: process.env.NEON_BRANCH ?? '',
  appSecret: (() => {
    const s = env('APP_SECRET', isProd ? undefined : 'dev-only-secret-change-me-0123456789abcdef');
    if (isProd && s.length < 32) throw new Error('APP_SECRET must be at least 32 characters in production');
    return s;
  })(),
  storageDir: env('STORAGE_DIR', '.storage'),
  storage: {
    /** 'local' = disk under STORAGE_DIR (development); 's3' = any S3-compatible bucket (Cloudflare R2, MinIO, AWS). */
    driver: env('STORAGE_DRIVER', 'local') as 'local' | 's3',
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? '',
      region: process.env.S3_REGION || 'auto',
      bucket: process.env.S3_BUCKET ?? '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      /** Needed for MinIO; R2 and AWS work either way. */
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'false') === 'true',
    },
    /**
     * Hard ceiling for everything stored, across all organizations. Default 9 GB
     * keeps Cloudflare R2 inside its 10 GB free tier with a safety margin.
     */
    totalLimitBytes: Number(env('STORAGE_TOTAL_LIMIT_BYTES', String(9 * 1024 * 1024 * 1024))),
  },
  rateLimitEnabled: env('RATE_LIMIT', isTest ? 'off' : 'on') === 'on',

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },

  session: {
    ttlDays: 30,
    cookieName: 'tavern_sid',
  },

  tokens: {
    verifyEmailHours: 48,
    resetPasswordMinutes: 30,
  },

  invitations: {
    defaultExpiryDays: Number(env('INVITE_DEFAULT_EXPIRY_DAYS', '7')), // open question #5
    maxExpiryDays: 30,
    defaultMaxUses: 1, // open question #4 — single-use by default
  },

  uploads: {
    // "Needs approval" — 25 MB per file, common documents/images only.
    maxBytes: Number(env('UPLOAD_MAX_BYTES', String(25 * 1024 * 1024))),
    tenantQuotaBytes: Number(env('TENANT_STORAGE_QUOTA_BYTES', String(2 * 1024 * 1024 * 1024))),
    uploadUrlTtlSeconds: 10 * 60,
    downloadUrlTtlSeconds: 60,
    allowed: {
      pdf: ['application/pdf'],
      png: ['image/png'],
      jpg: ['image/jpeg'],
      jpeg: ['image/jpeg'],
      gif: ['image/gif'],
      webp: ['image/webp'],
      txt: ['text/plain'],
      md: ['text/markdown', 'text/plain'],
      csv: ['text/csv', 'text/plain'],
      json: ['application/json', 'text/plain'],
      docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    } as Record<string, string[]>,
  },
};
