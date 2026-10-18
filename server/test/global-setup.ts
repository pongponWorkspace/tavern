// Recreates the tavern_test database from scratch and applies all migrations
// once per `vitest run`.
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

export default async function setup() {
  const testUrl = process.env.TEST_DATABASE_URL || 'postgres://tavern:tavern@localhost:54329/tavern_test';
  const parsed = new URL(testUrl);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+_test$/.test(dbName)) throw new Error(`Refusing to recreate non-test database "${dbName}"`);

  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/tavern';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  await migrate(testUrl, () => {});
}
