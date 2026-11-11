import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Config } from '../config.js';

export const DELIVERY_QUEUE = 'deliveries';
export const DELIVERY_JOB = 'deliver';
export const DELIVERY_BACKOFF = 'delivery';

export const QUEUE_OPERATION_TIMEOUT_MS = 3000;

export interface DeliveryJobData {
  deliveryId: string;
}

export interface DeliveryQueue {
  enqueue(deliveryIds: string[]): Promise<void>;
  requeue(deliveryId: string): Promise<void>;
  close(): Promise<void>;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Queue operation timed out')), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export function createDeliveryQueue(
  connection: Redis,
  config: Pick<Config, 'MAX_ATTEMPTS'>,
): DeliveryQueue {
  const queue = new Queue<DeliveryJobData, void, typeof DELIVERY_JOB>(DELIVERY_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: config.MAX_ATTEMPTS,
      backoff: { type: DELIVERY_BACKOFF },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  queue.on('error', () => undefined);

  return {
    async enqueue(deliveryIds) {
      if (deliveryIds.length === 0) return;
      await withTimeout(
        queue.addBulk(
          deliveryIds.map((deliveryId) => ({
            name: DELIVERY_JOB,
            data: { deliveryId },
            opts: { jobId: deliveryId },
          })),
        ),
        QUEUE_OPERATION_TIMEOUT_MS,
      );
    },
    async requeue(deliveryId) {
      const replace = async () => {
        const existing = await queue.getJob(deliveryId);
        if (existing && !(await existing.isActive())) {
          await existing.remove();
        }
        await queue.add(DELIVERY_JOB, { deliveryId }, { jobId: deliveryId });
      };
      await withTimeout(replace(), QUEUE_OPERATION_TIMEOUT_MS);
    },
    async close() {
      await queue.close();
    },
  };
}
