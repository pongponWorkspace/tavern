// Runs in every test worker before any test file is imported, so src/config.ts
// (which reads process.env at import time) always sees the test configuration.
import os from 'node:os';
import path from 'node:path';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://tavern:tavern@localhost:54329/tavern_test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.APP_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.STORAGE_DIR = path.join(os.tmpdir(), 'tavern-test-storage');
process.env.RATE_LIMIT = 'off';
// Google stays disabled; the callback's state check runs regardless.
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
