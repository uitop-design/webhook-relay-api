import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '../../db/client.js';

export type DependencyStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'error';
  checks: { postgres: DependencyStatus; redis: DependencyStatus };
  failed: string[];
}

export interface HealthServiceDeps {
  db: Database;
  redis: Pick<Redis, 'ping'>;
  timeoutMs?: number;
}

async function probe(check: () => Promise<unknown>, timeoutMs: number): Promise<DependencyStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Health check timed out')), timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export function createHealthService({ db, redis, timeoutMs = 2000 }: HealthServiceDeps) {
  return {
    async check(): Promise<HealthReport> {
      const [postgres, redisStatus] = await Promise.all([
        probe(() => db.execute(sql`select 1`), timeoutMs),
        probe(() => redis.ping(), timeoutMs),
      ]);
      const checks = { postgres, redis: redisStatus };
      const failed = Object.entries(checks)
        .filter(([, status]) => status === 'down')
        .map(([name]) => name);
      return { status: failed.length === 0 ? 'ok' : 'error', checks, failed };
    },
  };
}

export type HealthService = ReturnType<typeof createHealthService>;
