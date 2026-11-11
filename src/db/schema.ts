import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const DELIVERY_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'DEAD'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const deliveryStatus = pgEnum('delivery_status', DELIVERY_STATUSES);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const endpoints = pgTable(
  'endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    url: text('url').notNull(),
    description: text('description'),
    secret: text('secret').notNull(),
    eventTypes: text('event_types')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('endpoints_created_at_idx').on(table.createdAt)],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('events_created_at_idx').on(table.createdAt),
    index('events_type_created_at_idx').on(table.type, table.createdAt),
  ],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => endpoints.id, { onDelete: 'cascade' }),
    status: deliveryStatus('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('deliveries_event_endpoint_uq').on(table.eventId, table.endpointId),
    index('deliveries_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
    index('deliveries_endpoint_status_idx').on(table.endpointId, table.status),
    index('deliveries_created_at_idx').on(table.createdAt),
    index('deliveries_pending_created_at_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'PENDING'`),
  ],
);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    statusCode: integer('status_code'),
    durationMs: integer('duration_ms').notNull(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (table) => [index('delivery_attempts_delivery_idx').on(table.deliveryId, table.createdAt)],
);

export type EndpointRow = typeof endpoints.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;
