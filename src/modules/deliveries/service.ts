import { and, asc, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../../db/client.js';
import {
  deliveries,
  deliveryAttempts,
  type DeliveryAttemptRow,
  type DeliveryRow,
  type DeliveryStatus,
} from '../../db/schema.js';
import type { DeliveryQueue } from '../../delivery/queue.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { offsetOf, type Page } from '../../lib/schemas.js';
import type { DeliveriesQuery } from './schemas.js';

export const RETRYABLE_STATUSES: readonly DeliveryStatus[] = ['FAILED', 'DEAD'];

export interface DeliveriesServiceDeps {
  db: Database;
  queue: Pick<DeliveryQueue, 'requeue'>;
  logger: Logger;
}

export function createDeliveriesService({ db, queue, logger }: DeliveriesServiceDeps) {
  return {
    async list(query: DeliveriesQuery): Promise<Page<DeliveryRow>> {
      const filters: SQL[] = [];
      if (query.status) filters.push(eq(deliveries.status, query.status));
      if (query.endpointId) filters.push(eq(deliveries.endpointId, query.endpointId));
      if (query.eventId) filters.push(eq(deliveries.eventId, query.eventId));
      const where = filters.length > 0 ? and(...filters) : undefined;

      const [items, [totals]] = await Promise.all([
        db
          .select()
          .from(deliveries)
          .where(where)
          .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
          .limit(query.limit)
          .offset(offsetOf(query)),
        db.select({ total: count() }).from(deliveries).where(where),
      ]);
      return { items, total: totals?.total ?? 0, page: query.page, limit: query.limit };
    },

    async get(id: string): Promise<DeliveryRow & { attemptHistory: DeliveryAttemptRow[] }> {
      const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, id));
      if (!delivery) throw new NotFoundError('Delivery');
      const attemptHistory = await db
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.deliveryId, id))
        .orderBy(asc(deliveryAttempts.createdAt), asc(deliveryAttempts.attemptNo));
      return { ...delivery, attemptHistory };
    },

    async retry(id: string): Promise<DeliveryRow> {
      const [updated] = await db
        .update(deliveries)
        .set({ status: 'PENDING', attempts: 0, nextAttemptAt: null })
        .where(and(eq(deliveries.id, id), inArray(deliveries.status, [...RETRYABLE_STATUSES])))
        .returning();

      if (!updated) {
        const [existing] = await db
          .select({ status: deliveries.status })
          .from(deliveries)
          .where(eq(deliveries.id, id));
        if (!existing) throw new NotFoundError('Delivery');
        throw new ConflictError(
          `Only ${RETRYABLE_STATUSES.join(' or ')} deliveries can be retried (current status: ${existing.status})`,
        );
      }

      try {
        await queue.requeue(id);
      } catch (error) {
        logger.warn(
          { err: error, deliveryId: id },
          'Retry was not enqueued; the worker recovery loop will pick it up',
        );
      }
      return updated;
    },
  };
}

export type DeliveriesService = ReturnType<typeof createDeliveriesService>;
