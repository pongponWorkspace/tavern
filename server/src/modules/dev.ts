import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';

/** Development-only test email sink (§14.3). Never registered in production. */
export async function devRoutes(app: FastifyInstance) {
  app.get('/dev/mailbox', async () => {
    const rows = await query(pool, `SELECT id, to_email, subject, body_text, created_at FROM email_outbox ORDER BY created_at DESC LIMIT 50`);
    return { data: rows.map((r) => ({ id: r.id, to: r.to_email, subject: r.subject, body: r.body_text, createdAt: r.created_at })) };
  });
}
