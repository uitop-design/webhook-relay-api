import { Worker } from 'bullmq';
import { loadConfig, loadEnvFile } from './config.js';
import { createDatabase } from './db/client.js';
import { createDeliveryProcessor, retryDelay, RetryDeliveryError } from './delivery/processor.js';
import { createDeliveryQueue, DELIVERY_QUEUE, type DeliveryJobData } from './delivery/queue.js';
import { sendWebhook } from './delivery/sender.js';
import { createDeliveryStore } from './delivery/store.js';
import { createTargetResolver } from './delivery/url-guard.js';
import { createLogger } from './lib/logger.js';
import { createRedis } from './lib/redis.js';

const RECOVERY_BATCH_SIZE = 500;

loadEnvFile();
const config = loadConfig();
const logger = createLogger(config, 'worker');

const { db, pool } = createDatabase(config.DATABASE_URL);
const connection = createRedis(config.REDIS_URL, 'worker', logger);
const queue = createDeliveryQueue(connection, config);
const store = createDeliveryStore(db);

const processDelivery = createDeliveryProcessor({
  store,
  send: sendWebhook,
  resolveTarget: createTargetResolver({ allowPrivate: config.ALLOW_PRIVATE_URLS }),
  config,
  logger,
});

const worker = new Worker<DeliveryJobData>(
  DELIVERY_QUEUE,
  async (job) => {
    await processDelivery(job.data.deliveryId, {
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
    });
  },
  {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
    settings: {
      backoffStrategy: (attemptsMade, _type, error) =>
        error instanceof RetryDeliveryError
          ? error.delayMs
          : retryDelay(attemptsMade, config.RETRY_BASE_MS),
    },
  },
);

worker.on('error', (error) => logger.debug({ err: error }, 'Worker error'));
worker.on('failed', (job, error) => {
  if (!(error instanceof RetryDeliveryError)) {
    logger.error({ err: error, deliveryId: job?.data.deliveryId }, 'Delivery job crashed');
  }
});

let recovering = false;
async function recoverPending(): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    const createdBefore = new Date(Date.now() - config.RECOVERY_INTERVAL_MS);
    const ids = await store.findStalePending(createdBefore, RECOVERY_BATCH_SIZE);
    if (ids.length > 0) {
      await queue.enqueue(ids);
      logger.info({ count: ids.length }, 'Re-enqueued stale pending deliveries');
    }
  } catch (error) {
    logger.warn({ err: error }, 'Pending delivery recovery failed');
  } finally {
    recovering = false;
  }
}

const recoveryTimer = setInterval(() => void recoverPending(), config.RECOVERY_INTERVAL_MS);
void recoverPending();
logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'Delivery worker started');

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  clearInterval(recoveryTimer);
  try {
    await worker.close();
    await queue.close();
    connection.disconnect();
    await pool.end();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Shutdown failed');
    process.exit(1);
  }
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));
