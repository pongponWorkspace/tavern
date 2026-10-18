import { query, type Db } from '../db/pool.js';
import { config } from '../config.js';

/**
 * Queue an email. There is no SMTP provider wired up for the MVP: in
 * development the email_outbox table is the test sink (GET /api/v1/dev/mailbox).
 * A production deployment plugs a provider worker in here.
 */
export async function sendMail(db: Db, to: string, subject: string, body: string): Promise<void> {
  await query(db, 'INSERT INTO email_outbox (to_email, subject, body_text) VALUES ($1,$2,$3)', [to, subject, body]);
}

export const appLink = (path: string) => `${config.appOrigin}${path}`;
