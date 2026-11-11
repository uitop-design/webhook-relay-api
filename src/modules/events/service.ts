import { and, arrayContains, asc, count, desc, eq, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../../db/client.js';
import { deliveries, endpoints, events, type DeliveryRow, type EventRow } from '../../db/schema.js';
import type { DeliveryQueue } from '../../delivery/queue.js';
import { NotFoundError } from '../../lib/errors.js';
import { offsetOf, type Page } from '../../lib/schemas.js';
import type { EventsQuery, PublishEventInput } from './schemas.js';

export interface EventsServiceDeps {
  db: Database;
  queue: Pick<DeliveryQueue, 'enqueue'>;
  logger: Logger;
}

export interface PublishedEvent {
  event: EventRow;
  deliveries: number;
}

export function createEventsService({ db, queue, logger }: EventsServiceDeps) {
  return {
    async publish(input: PublishEventInput): Promise<PublishedEvent> {
      const { event, deliveryIds } = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(events)
          .values({ type: input.type, payload: input.payload })
          .returning();
        const created = inserted!;

        const subscribers = await tx
          .select({ id: endpoints.id })
          .from(endpoints)
          .where(
            and(
              eq(endpoints.active, true),
              or(
                sql`cardinality(${endpoints.eventTypes}) = 0`,
                arrayContains(endpoints.eventTypes, [input.type]),
              ),
            ),
          );

        const rows =
          subscribers.length === 0
            ? []
            : await tx
                .insert(deliveries)
                .values(subscribers.map(({ id }) => ({ eventId: created.id, endpointId: id })))
                .returning({ id: deliveries.id });

        return { event: created, deliveryIds: rows.map(({ id }) => id) };
      });

      try {
        await queue.enqueue(deliveryIds);
      } catch (error) {
        logger.warn(
          { err: error, eventId: event.id, deliveries: deliveryIds.length },
          'Deliveries were not enqueued; the worker recovery loop will pick them up',
        );
      }

      return { event, deliveries: deliveryIds.length };
    },

    async list(query: EventsQuery): Promise<Page<EventRow>> {
      const where = query.type ? eq(events.type, query.type) : undefined;
      const [items, [totals]] = await Promise.all([
        db
          .select()
          .from(events)
          .where(where)
          .orderBy(desc(events.createdAt), desc(events.id))
          .limit(query.limit)
          .offset(offsetOf(query)),
        db.select({ total: count() }).from(events).where(where),
      ]);
      return { items, total: totals?.total ?? 0, page: query.page, limit: query.limit };
    },

    async get(id: string): Promise<EventRow & { deliveries: DeliveryRow[] }> {
      const [event] = await db.select().from(events).where(eq(events.id, id));
      if (!event) throw new NotFoundError('Event');
      const eventDeliveries = await db
        .select()
        .from(deliveries)
        .where(eq(deliveries.eventId, id))
        .orderBy(asc(deliveries.createdAt), asc(deliveries.id));
      return { ...event, deliveries: eventDeliveries };
    },
  };
}

export type EventsService = ReturnType<typeof createEventsService>;
