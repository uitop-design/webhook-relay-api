import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { pino } from 'pino';
import { vi, type Mock } from 'vitest';
import type { AppServices } from '../src/app.js';
import type { Database } from '../src/db/client.js';

export const silentLogger = pino({ level: 'silent' });

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface DbMock {
  db: Database;
  calls: RecordedCall[];
  queue(...results: unknown[]): void;
  callsOf(method: string): RecordedCall[];
}

export function createDbMock(): DbMock {
  const results: unknown[] = [];
  const calls: RecordedCall[] = [];

  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          const value = results.shift();
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)).then(
              resolve,
              reject,
            );
        }
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return chain();
        };
      },
    });

  const db: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
        }
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return chain();
        };
      },
    },
  );

  return {
    db: db as unknown as Database,
    calls,
    queue: (...values) => results.push(...values),
    callsOf: (method) => calls.filter((call) => call.method === method),
  };
}

const dialect = new PgDialect();

export function renderSql(fragment: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(fragment as SQL);
}

type ServiceMocks = {
  [K in keyof AppServices]: {
    [M in keyof AppServices[K]]: AppServices[K][M] extends (...args: never[]) => unknown
      ? Mock<AppServices[K][M]>
      : never;
  };
};

type Services = AppServices;

export function createServiceMocks(): ServiceMocks {
  return {
    endpoints: {
      create: vi.fn<Services['endpoints']['create']>(),
      list: vi.fn<Services['endpoints']['list']>(),
      get: vi.fn<Services['endpoints']['get']>(),
      update: vi.fn<Services['endpoints']['update']>(),
      remove: vi.fn<Services['endpoints']['remove']>(),
      rotateSecret: vi.fn<Services['endpoints']['rotateSecret']>(),
    },
    events: {
      publish: vi.fn<Services['events']['publish']>(),
      list: vi.fn<Services['events']['list']>(),
      get: vi.fn<Services['events']['get']>(),
    },
    deliveries: {
      list: vi.fn<Services['deliveries']['list']>(),
      get: vi.fn<Services['deliveries']['get']>(),
      retry: vi.fn<Services['deliveries']['retry']>(),
    },
    health: { check: vi.fn<Services['health']['check']>() },
  };
}

export const asServices = (mocks: ServiceMocks) => mocks as unknown as AppServices;

export const ids = {
  endpoint: '6f1c2a40-0d4e-4b8a-9a51-1c0f3e7a2b01',
  event: '9a7e5d10-3b2c-4f6e-8d41-5e2b7c9f0a01',
  delivery: 'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0001',
  missing: '00000000-0000-4000-8000-000000000000',
};

export const fixedDate = new Date('2026-11-11T12:00:00.000Z');

export function endpointRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.endpoint,
    url: 'https://example.com/hooks/orders',
    description: 'Orders',
    secret: 'whsec_existing',
    eventTypes: ['order.created'],
    active: true,
    createdAt: fixedDate,
    updatedAt: fixedDate,
    ...overrides,
  };
}

export function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.event,
    type: 'order.created',
    payload: { orderId: 42 },
    createdAt: fixedDate,
    ...overrides,
  };
}

export function deliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.delivery,
    eventId: ids.event,
    endpointId: ids.endpoint,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: null,
    lastStatusCode: null,
    lastError: null,
    createdAt: fixedDate,
    updatedAt: fixedDate,
    ...overrides,
  };
}
