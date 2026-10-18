import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const hmac = (value: string) => createHmac('sha256', config.appSecret).update(value).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Hash an IP with the app secret so audit rows don't store raw addresses. */
export const hashIp = (ip: string | undefined) => (ip ? hmac(`ip:${ip}`).slice(0, 24) : null);
