import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig, loadEnvFile } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { createDatabase } from './client.js';

loadEnvFile();
const config = loadConfig();
const logger = createLogger(config, 'migrate');
const { db, pool } = createDatabase(config.DATABASE_URL);

try {
  await migrate(db, { migrationsFolder: resolve(import.meta.dirname, '../../drizzle') });
  logger.info('Migrations applied');
} catch (error) {
  logger.error({ err: error }, 'Migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
