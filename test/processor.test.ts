import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeliveryProcessor,
  MAX_ERROR_LENGTH,
  retryDelay,
  RetryDeliveryError,
} from '../src/delivery/processor.js';
import type { SendResult, WebhookSender } from '../src/delivery/sender.js';
import { sign } from '../src/delivery/signature.js';
import type { DeliveryContext, DeliveryStore } from '../src/delivery/store.js';
import { UnsafeUrlError, type TargetResolver } from '../src/delivery/url-guard.js';
import { deliveryRow, endpointRow, eventRow, fixedDate, ids, silentLogger } from './helpers.js';

const config = { MAX_ATTEMPTS: 5, RETRY_BASE_MS: 2000, DELIVERY_TIMEOUT_MS: 5000 };
const firstJob = { attemptsMade: 0, maxAttempts: 5 };

function context(
  overrides: { delivery?: Record<string, unknown>; endpoint?: Record<string, unknown> } = {},
): DeliveryContext {
  return {
    delivery: deliveryRow(overrides.delivery),
    endpoint: endpointRow({ url: 'https://hooks.example.com/orders', ...overrides.endpoint }),
    event: eventRow(),
  } as DeliveryContext;
}

function setup(result: SendResult | Error, ctx: DeliveryContext | null = context()) {
  const store = {
    load: vi.fn<DeliveryStore['load']>().mockResolvedValue(ctx ?? undefined),
    recordAttempt: vi.fn<DeliveryStore['recordAttempt']>().mockResolvedValue(true),
    markDead: vi.fn<DeliveryStore['markDead']>().mockResolvedValue(),
    findStalePending: vi.fn<DeliveryStore['findStalePending']>(),
  };
  const send = vi.fn<WebhookSender>();
  if (result instanceof Error) send.mockRejectedValue(result);
  else send.mockResolvedValue(result);
  const addresses = [{ address: '93.184.215.14', family: 4 }];
  const resolveTarget = vi.fn<TargetResolver>().mockResolvedValue(addresses);
  const processDelivery = createDeliveryProcessor({
    store,
    send,
    resolveTarget,
    config,
    logger: silentLogger,
    now: () => fixedDate,
  });
  return { store, send, resolveTarget, processDelivery, addresses };
}

const ok = (statusCode = 200): SendResult => ({ statusCode, durationMs: 42, error: null });

describe('delivery processor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends a signed request to the pinned address and marks 2xx as SUCCEEDED', async () => {
    const { processDelivery, send, store, addresses } = setup(ok(204));

    await expect(processDelivery(ids.delivery, firstJob)).resolves.toBe('SUCCEEDED');

    const request = send.mock.calls[0]![0];
    const timestamp = Math.floor(fixedDate.getTime() / 1000);
    expect(request.url).toBe('https://hooks.example.com/orders');
    expect(request.timeoutMs).toBe(5000);
    expect(request.addresses).toBe(addresses);
    expect(JSON.parse(request.body)).toEqual({
      id: ids.event,
      type: 'order.created',
      createdAt: fixedDate.toISOString(),
      payload: { orderId: 42 },
    });
    expect(request.headers).toMatchObject({
      'x-webhook-id': ids.delivery,
      'x-webhook-event': 'order.created',
      'x-webhook-timestamp': String(timestamp),
      'x-webhook-signature': sign('whsec_existing', timestamp, request.body),
    });
    expect(store.recordAttempt).toHaveBeenCalledWith({
      deliveryId: ids.delivery,
      attemptNo: 1,
      statusCode: 204,
      durationMs: 42,
      error: null,
      status: 'SUCCEEDED',
      nextAttemptAt: null,
    });
  });

  it('marks 5xx as FAILED with nextAttemptAt and asks BullMQ to retry with backoff', async () => {
    const { processDelivery, store } = setup(ok(503), context({ delivery: { attempts: 1 } }));

    const error = await processDelivery(ids.delivery, { attemptsMade: 1, maxAttempts: 5 }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RetryDeliveryError);
    expect((error as RetryDeliveryError).delayMs).toBe(4000);
    expect(store.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptNo: 2,
        status: 'FAILED',
        statusCode: 503,
        error: 'Endpoint responded with status 503',
        nextAttemptAt: new Date(fixedDate.getTime() + 4000),
      }),
    );
  });

  it('marks the last failed attempt as DEAD without scheduling a retry', async () => {
    const { processDelivery, store } = setup(ok(500), context({ delivery: { attempts: 4 } }));

    await expect(processDelivery(ids.delivery, { attemptsMade: 4, maxAttempts: 5 })).resolves.toBe(
      'DEAD',
    );
    expect(store.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attemptNo: 5, status: 'DEAD', nextAttemptAt: null }),
    );
  });

  it('treats an exhausted BullMQ job as the last attempt', async () => {
    const { processDelivery, store } = setup(ok(500));

    await expect(processDelivery(ids.delivery, { attemptsMade: 4, maxAttempts: 5 })).resolves.toBe(
      'DEAD',
    );
    expect(store.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: 'DEAD' }));
  });

  it('deactivates the endpoint and marks DEAD immediately on 410 Gone', async () => {
    const { processDelivery, store } = setup(ok(410));

    await expect(processDelivery(ids.delivery, firstJob)).resolves.toBe('DEAD');
    expect(store.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptNo: 1,
        status: 'DEAD',
        statusCode: 410,
        deactivateEndpointId: ids.endpoint,
      }),
    );
  });

  it('counts a timeout as a failed attempt', async () => {
    const { processDelivery, store } = setup({
      statusCode: null,
      durationMs: 5001,
      error: 'Request timed out after 5000 ms',
    });

    await expect(processDelivery(ids.delivery, firstJob)).rejects.toBeInstanceOf(
      RetryDeliveryError,
    );
    expect(store.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        statusCode: null,
        durationMs: 5001,
        error: 'Request timed out after 5000 ms',
      }),
    );
  });

  it('records a rejected target as a failed attempt without sending', async () => {
    const { processDelivery, send, store, resolveTarget } = setup(ok());
    resolveTarget.mockRejectedValue(new UnsafeUrlError('Host resolves to a private address'));

    await expect(processDelivery(ids.delivery, firstJob)).rejects.toBeInstanceOf(
      RetryDeliveryError,
    );
    expect(send).not.toHaveBeenCalled();
    expect(store.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED', error: 'Host resolves to a private address' }),
    );
  });

  it(`truncates error messages to ${MAX_ERROR_LENGTH} characters`, async () => {
    const { processDelivery, store } = setup({
      statusCode: null,
      durationMs: 1,
      error: 'x'.repeat(2000),
    });

    await processDelivery(ids.delivery, firstJob).catch(() => undefined);
    expect(store.recordAttempt.mock.calls[0]![0].error).toHaveLength(MAX_ERROR_LENGTH);
  });

  it('drops deliveries of an inactive endpoint as DEAD without sending', async () => {
    const { processDelivery, send, store } = setup(ok(), context({ endpoint: { active: false } }));

    await expect(processDelivery(ids.delivery, firstJob)).resolves.toBe('DEAD');
    expect(send).not.toHaveBeenCalled();
    expect(store.markDead).toHaveBeenCalledWith(ids.delivery, 'Endpoint is inactive');
  });

  it.each(['SUCCEEDED', 'DEAD'])('skips deliveries already %s', async (status) => {
    const { processDelivery, send } = setup(ok(), context({ delivery: { status } }));

    await expect(processDelivery(ids.delivery, firstJob)).resolves.toBe('SKIPPED');
    expect(send).not.toHaveBeenCalled();
  });

  it('skips deliveries that no longer exist', async () => {
    const { processDelivery, send } = setup(ok(), null);

    await expect(processDelivery(ids.delivery, firstJob)).resolves.toBe('SKIPPED');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not retry when the delivery was deleted during the attempt', async () => {
    const { processDelivery, store } = setup(ok(500));
    store.recordAttempt.mockResolvedValue(false);

    await expect(processDelivery(ids.delivery, firstJob)).resolves.toBe('SKIPPED');
  });
});

describe('retryDelay', () => {
  it('grows exponentially from the base delay', () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelay(attempt, 2000))).toEqual([
      2000, 4000, 8000, 16000,
    ]);
  });
});
