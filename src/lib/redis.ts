import { Redis } from 'ioredis';
import type { Logger } from 'pino';

export type RedisRole = 'client' | 'worker';

export interface ConnectionState {
  down(error?: unknown): void;
  up(): void;
}

export function createConnectionState(logger: Logger, name: string): ConnectionState {
  let available = true;
  return {
    down(error) {
      if (!available) return;
      available = false;
      logger.warn({ err: error }, `${name} connection lost`);
    },
    up() {
      if (available) return;
      available = true;
      logger.info(`${name} connection restored`);
    },
  };
}

export function createRedis(url: string, role: RedisRole, logger: Logger): Redis {
  const redis =
    role === 'worker'
      ? new Redis(url, {
          maxRetriesPerRequest: null,
          retryStrategy: (times) => Math.min(times * 500, 5000),
        })
      : new Redis(url, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 2000,
          commandTimeout: 2000,
          retryStrategy: (times) => Math.min(times * 500, 5000),
        });

  const state = createConnectionState(logger, 'Redis');
  redis.on('error', (error) => state.down(error));
  redis.on('ready', () => state.up());
  return redis;
}
