import { and, asc, eq, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  deliveries,
  deliveryAttempts,
  endpoints,
  events,
  type DeliveryRow,
  type DeliveryStatus,
  type EndpointRow,
  type EventRow,
} from '../db/schema.js';

export interface DeliveryContext {
  delivery: DeliveryRow;
  endpoint: EndpointRow;
  event: EventRow;
}

export interface AttemptRecord {
  deliveryId: string;
  attemptNo: number;
  statusCode: number | null;
  durationMs: number;
  error: string | null;
  status: Exclude<DeliveryStatus, 'PENDING'>;
  nextAttemptAt: Date | null;
  deactivateEndpointId?: string;
}

export interface DeliveryStore {
  load(deliveryId: string): Promise<DeliveryContext | undefined>;
  recordAttempt(record: AttemptRecord): Promise<void>;
  markDead(deliveryId: string, error: string): Promise<void>;
  findStalePending(createdBefore: Date, limit: number): Promise<string[]>;
}

export function createDeliveryStore(db: Database): DeliveryStore {
  return {
    async load(deliveryId) {
      const [row] = await db
        .select()
        .from(deliveries)
        .innerJoin(endpoints, eq(endpoints.id, deliveries.endpointId))
        .innerJoin(events, eq(events.id, deliveries.eventId))
        .where(eq(deliveries.id, deliveryId));
      return row && { delivery: row.deliveries, endpoint: row.endpoints, event: row.events };
    },

    async recordAttempt(record) {
      await db.transaction(async (tx) => {
        await tx.insert(deliveryAttempts).values({
          deliveryId: record.deliveryId,
          attemptNo: record.attemptNo,
          statusCode: record.statusCode,
          durationMs: record.durationMs,
          error: record.error,
        });
        await tx
          .update(deliveries)
          .set({
            status: record.status,
            attempts: record.attemptNo,
            nextAttemptAt: record.nextAttemptAt,
            lastStatusCode: record.statusCode,
            lastError: record.error,
          })
          .where(eq(deliveries.id, record.deliveryId));
        if (record.deactivateEndpointId) {
          await tx
            .update(endpoints)
            .set({ active: false })
            .where(eq(endpoints.id, record.deactivateEndpointId));
        }
      });
    },

    async markDead(deliveryId, error) {
      await db
        .update(deliveries)
        .set({ status: 'DEAD', nextAttemptAt: null, lastError: error })
        .where(eq(deliveries.id, deliveryId));
    },

    async findStalePending(createdBefore, limit) {
      const rows = await db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(and(eq(deliveries.status, 'PENDING'), lt(deliveries.createdAt, createdBefore)))
        .orderBy(asc(deliveries.createdAt))
        .limit(limit);
      return rows.map(({ id }) => id);
    },
  };
}
