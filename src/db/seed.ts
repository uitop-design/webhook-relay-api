import { loadConfig, loadEnvFile } from '../config.js';
import { generateSecret } from '../delivery/signature.js';
import { createLogger } from '../lib/logger.js';
import { createDatabase } from './client.js';
import { deliveries, deliveryAttempts, endpoints, events } from './schema.js';

const at = (iso: string) => new Date(iso);

const ENDPOINTS = [
  {
    id: '6f1c2a40-0d4e-4b8a-9a51-1c0f3e7a2b01',
    url: 'https://example.com/hooks/orders',
    description: 'Order service',
    eventTypes: ['order.created', 'order.paid'],
    active: true,
  },
  {
    id: '6f1c2a40-0d4e-4b8a-9a51-1c0f3e7a2b02',
    url: 'https://example.com/hooks/billing',
    description: 'Billing service',
    eventTypes: ['invoice.paid'],
    active: true,
  },
  {
    id: '6f1c2a40-0d4e-4b8a-9a51-1c0f3e7a2b03',
    url: 'https://example.com/hooks/audit',
    description: 'Audit log (returned 410 Gone, deactivated)',
    eventTypes: [],
    active: false,
  },
] as const;

const [orders, billing, audit] = ENDPOINTS;

const EVENTS = [
  {
    id: '9a7e5d10-3b2c-4f6e-8d41-5e2b7c9f0a01',
    type: 'order.created',
    payload: { orderId: 'ord_1001', total: 49.9, currency: 'EUR' },
    createdAt: at('2026-11-10T09:15:00Z'),
  },
  {
    id: '9a7e5d10-3b2c-4f6e-8d41-5e2b7c9f0a02',
    type: 'order.paid',
    payload: { orderId: 'ord_1001', paymentId: 'pay_501' },
    createdAt: at('2026-11-10T09:20:00Z'),
  },
  {
    id: '9a7e5d10-3b2c-4f6e-8d41-5e2b7c9f0a03',
    type: 'invoice.paid',
    payload: { invoiceId: 'inv_2001', amount: 120 },
    createdAt: at('2026-11-10T10:00:00Z'),
  },
] as const;

const [orderCreated, orderPaid, invoicePaid] = EVENTS;

const DELIVERIES = [
  {
    id: 'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0001',
    eventId: orderCreated.id,
    endpointId: orders.id,
    status: 'SUCCEEDED' as const,
    attempts: 1,
    nextAttemptAt: null,
    lastStatusCode: 200,
    lastError: null,
    createdAt: at('2026-11-10T09:15:00Z'),
    updatedAt: at('2026-11-10T09:15:01Z'),
  },
  {
    id: 'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0002',
    eventId: orderCreated.id,
    endpointId: audit.id,
    status: 'SUCCEEDED' as const,
    attempts: 1,
    nextAttemptAt: null,
    lastStatusCode: 204,
    lastError: null,
    createdAt: at('2026-11-10T09:15:00Z'),
    updatedAt: at('2026-11-10T09:15:01Z'),
  },
  {
    id: 'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0003',
    eventId: orderPaid.id,
    endpointId: orders.id,
    status: 'FAILED' as const,
    attempts: 2,
    nextAttemptAt: at('2026-11-10T09:20:07Z'),
    lastStatusCode: null,
    lastError: 'Request timed out after 5000 ms',
    createdAt: at('2026-11-10T09:20:00Z'),
    updatedAt: at('2026-11-10T09:20:03Z'),
  },
  {
    id: 'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0004',
    eventId: invoicePaid.id,
    endpointId: billing.id,
    status: 'DEAD' as const,
    attempts: 5,
    nextAttemptAt: null,
    lastStatusCode: 503,
    lastError: 'Endpoint responded with status 503',
    createdAt: at('2026-11-10T10:00:00Z'),
    updatedAt: at('2026-11-10T10:00:31Z'),
  },
  {
    id: 'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0005',
    eventId: orderPaid.id,
    endpointId: audit.id,
    status: 'DEAD' as const,
    attempts: 1,
    nextAttemptAt: null,
    lastStatusCode: 410,
    lastError: 'Endpoint responded with status 410',
    createdAt: at('2026-11-10T09:20:00Z'),
    updatedAt: at('2026-11-10T09:20:01Z'),
  },
];

const ATTEMPTS = [
  ['c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0001', 1, 200, 84, null, '2026-11-10T09:15:01Z'],
  ['c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0002', 1, 204, 61, null, '2026-11-10T09:15:01Z'],
  [
    'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0003',
    1,
    500,
    120,
    'Endpoint responded with status 500',
    '2026-11-10T09:20:01Z',
  ],
  [
    'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0003',
    2,
    null,
    5001,
    'Request timed out after 5000 ms',
    '2026-11-10T09:20:03Z',
  ],
  [
    'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0004',
    1,
    503,
    95,
    'Endpoint responded with status 503',
    '2026-11-10T10:00:01Z',
  ],
  [
    'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0004',
    2,
    503,
    88,
    'Endpoint responded with status 503',
    '2026-11-10T10:00:03Z',
  ],
  [
    'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0004',
    3,
    503,
    91,
    'Endpoint responded with status 503',
    '2026-11-10T10:00:07Z',
  ],
  [
    'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0004',
    4,
    503,
    102,
    'Endpoint responded with status 503',
    '2026-11-10T10:00:15Z',
  ],
  [
    'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0004',
    5,
    503,
    97,
    'Endpoint responded with status 503',
    '2026-11-10T10:00:31Z',
  ],
  [
    'c3d2b1a0-1111-4a5b-8c6d-7e8f9a0b0005',
    1,
    410,
    70,
    'Endpoint responded with status 410',
    '2026-11-10T09:20:01Z',
  ],
] as const;

loadEnvFile();
const config = loadConfig();
const logger = createLogger(config, 'seed');
const { db, pool } = createDatabase(config.DATABASE_URL);

try {
  await db.transaction(async (tx) => {
    await tx
      .insert(endpoints)
      .values(
        ENDPOINTS.map((endpoint) => ({
          ...endpoint,
          eventTypes: [...endpoint.eventTypes],
          secret: generateSecret(),
          createdAt: at('2026-11-10T09:00:00Z'),
          updatedAt: at('2026-11-10T09:00:00Z'),
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(events)
      .values(EVENTS.map((event) => ({ ...event, payload: { ...event.payload } })))
      .onConflictDoNothing();
    const inserted = await tx
      .insert(deliveries)
      .values(DELIVERIES)
      .onConflictDoNothing()
      .returning({ id: deliveries.id });
    const fresh = new Set(inserted.map(({ id }) => id));
    const attempts = ATTEMPTS.filter(([deliveryId]) => fresh.has(deliveryId)).map(
      ([deliveryId, attemptNo, statusCode, durationMs, error, createdAt]) => ({
        deliveryId,
        attemptNo,
        statusCode,
        durationMs,
        error,
        createdAt: at(createdAt),
      }),
    );
    if (attempts.length > 0) await tx.insert(deliveryAttempts).values(attempts);
  });
  logger.info('Seed applied');
} catch (error) {
  logger.error({ err: error }, 'Seed failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
