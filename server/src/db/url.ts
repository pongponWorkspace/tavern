/**
 * Neon connection strings use sslmode=require. pg treats that as verify-full today but will
 * switch to weaker libpq semantics in v9; ask for verify-full explicitly to keep full
 * certificate checks and silence the deprecation warning.
 */
export function pgConnectionString(url: string): string {
  return url.replace(/([?&])sslmode=(prefer|require|verify-ca)(?=&|$)/, '$1sslmode=verify-full');
}
