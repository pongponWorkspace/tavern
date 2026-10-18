import pg from 'pg';
import { config } from '../config.js';
import { pgConnectionString } from './url.js';

export { pgConnectionString };

// Return timestamptz as ISO strings and bigint counts as numbers.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool | pg.PoolClient;



export const pool = new pg.Pool({
  connectionString: pgConnectionString(config.databaseUrl),
  max: 10,
  // Neon computes scale to zero; the first connection after a pause takes a moment to wake.
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
});

export async function query<T = any>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(text, params as any[]);
  return res.rows as T[];
}

export async function one<T = any>(db: Db, text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(db, text, params);
  return rows[0];
}

/** Run fn inside a transaction; commits on success, rolls back on throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
