import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { AppError } from './lib/errors.js';
import { randomToken, safeEqual } from './lib/crypto.js';
import { resolveSession } from './auth/session.js';
import { storage } from './storage/index.js';
import { requestContext } from './lib/request-context.js';
import type { SessionUser } from './authz/context.js';
import { authRoutes } from './auth/routes.js';
import { meRoutes } from './modules/me.js';
import { tenantRoutes } from './modules/tenants.js';
import { projectRoutes } from './modules/projects.js';
import { memberRoutes } from './modules/members.js';
import { invitationRoutes } from './modules/invitations.js';
import { knowledgeRoutes } from './modules/knowledge.js';
import { fileRoutes } from './modules/files.js';
import { onboardingRoutes } from './modules/onboarding.js';
import { auditRoutes } from './modules/audit-logs.js';
import { devRoutes } from './modules/dev.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    csrfToken: string | null;
  }
}

// Mutations that are legitimately made without a session (and so without a CSRF token).
const CSRF_EXEMPT = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/verify-email',
]);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isTest
      ? false
      : {
          level: config.isProd ? 'info' : 'warn',
          // Never log cookies, auth headers or query strings that may carry tokens/signatures.
          redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
          serializers: {
            req: (req) => ({ method: req.method, url: req.url.split('?')[0], id: req.id }),
          },
        },
    genReqId: () => `req_${randomToken(9)}`,
    trustProxy: config.isProd,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        // Direct-to-bucket uploads (S3/R2) need the bucket's origin; downloads are top-level navigations.
        connectSrc: ["'self'", ...(storage().browserOrigin ? [storage().browserOrigin!] : [])],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", 'https://accounts.google.com'],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd,
  });
  if (config.rateLimitEnabled) {
    await app.register(rateLimit, {
      global: false,
      errorResponseBuilder: (req, ctx) => ({
        statusCode: 429,
        error: { code: 'RATE_LIMITED', message: `Too many attempts. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`, requestId: req.id },
      }),
    });
  }

  // Request context for helpers deep in the call stack (runs before every other hook).
  app.addHook('onRequest', (req, _reply, done) => {
    const h = req.headers['x-preview-role'];
    const previewRole = h === 'maintainer' || h === 'member' || h === 'viewer' ? h : undefined;
    requestContext.run({ method: req.method, previewRole }, done);
  });

  app.decorateRequest('user', null);
  app.decorateRequest('csrfToken', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const session = await resolveSession(pool, req.cookies[config.session.cookieName]);
    req.user = session?.user ?? null;
    req.csrfToken = session?.csrfToken ?? null;

    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!mutating) return;
    const pathOnly = req.url.split('?')[0];
    if (pathOnly.startsWith('/api/v1/storage/')) return; // authorized by URL signature instead

    const origin = req.headers.origin;
    if (origin && origin !== config.appOrigin) {
      throw new AppError(403, 'CSRF_FAILED', 'Cross-origin request rejected.');
    }
    if (req.user && !CSRF_EXEMPT.has(pathOnly)) {
      const sent = req.headers['x-csrf-token'];
      if (typeof sent !== 'string' || !req.csrfToken || !safeEqual(sent, req.csrfToken)) {
        throw new AppError(403, 'CSRF_FAILED', 'Your session token is missing or stale. Refresh the page and try again.');
      }
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({
        error: { code: err.code, message: err.message, requestId: req.id, ...(err.details ? { details: err.details } : {}) },
      });
    }
    if (err.statusCode === 429) {
      return reply.status(429).send(err.error ? err : { error: { code: 'RATE_LIMITED', message: 'Too many requests.', requestId: req.id } });
    }
    if (err.validation || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err.statusCode === 400) {
      return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'The request body could not be read.', requestId: req.id } });
    }
    if (err.statusCode === 413) {
      return reply.status(413).send({ error: { code: 'VALIDATION_ERROR', message: 'The request is too large.', requestId: req.id } });
    }
    // Postgres constraint violations that slipped past validation.
    if (err.code === '23505') {
      return reply.status(409).send({ error: { code: 'CONFLICT', message: 'That name or value is already in use.', requestId: req.id } });
    }
    if (err.code === '23503' || err.code === '23514' || err.code === '22P02') {
      return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'The request references something that is not valid here.', requestId: req.id } });
    }
    req.log.error({ err, requestId: req.id }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong on our side.', requestId: req.id } });
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(meRoutes);
      await api.register(tenantRoutes);
      await api.register(projectRoutes);
      await api.register(memberRoutes);
      await api.register(invitationRoutes);
      await api.register(knowledgeRoutes);
      await api.register(fileRoutes);
      await api.register(onboardingRoutes);
      await api.register(auditRoutes);
      if (!config.isProd) await api.register(devRoutes);
      api.get('/health', async () => ({ ok: true }));
    },
    { prefix: '/api/v1' },
  );

  // In production the API also serves the built SPA from the same origin.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  const servingWeb = config.isProd && existsSync(webDist);
  if (servingWeb) await app.register(fastifyStatic, { root: webDist, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such endpoint.', requestId: req.id } });
    }
    if (servingWeb) return reply.sendFile('index.html');
    return reply.status(404).send('Not found');
  });

  return app;
}
