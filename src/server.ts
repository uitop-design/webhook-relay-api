import { buildApp } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';
import { createDatabase } from './db/client.js';
import { createTargetResolver } from './delivery/url-guard.js';
import { createLogger } from './lib/logger.js';
import { createRedis } from './lib/redis.js';
import { createEndpointsService } from './modules/endpoints/service.js';
import { createHealthService } from './modules/health/service.js';

loadEnvFile();
const config = loadConfig();
const logger = createLogger(config, 'api');

const { db, pool } = createDatabase(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL, 'client', logger);
const resolveTarget = createTargetResolver({ allowPrivate: config.ALLOW_PRIVATE_URLS });

const app = await buildApp({
  logger,
  services: {
    endpoints: createEndpointsService({ db, resolveTarget }),
    health: createHealthService({ db, redis }),
  },
});

app.addHook('onClose', async () => {
  redis.disconnect();
  await pool.end();
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Shutdown failed');
        process.exit(1);
      });
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  logger.error({ err: error }, 'Failed to start server');
  process.exit(1);
}
