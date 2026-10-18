import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { cleanupOrphanFiles } from './modules/files.js';

await migrate(config.databaseUrlDirect, () => {});
const app = await buildApp();
await app.listen({ port: config.port, host: config.isProd ? '0.0.0.0' : '127.0.0.1' });
console.log(`Tavern API listening on http://localhost:${config.port}`);

// Reliable cleanup of abandoned uploads (§12.3).
setInterval(() => cleanupOrphanFiles().catch((err) => app.log.error(err)), 60 * 60 * 1000).unref();
