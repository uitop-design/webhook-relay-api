import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { DeliveryQueue } from '../src/delivery/queue.js';
import { ConflictError, NotFoundError } from '../src/lib/errors.js';
import { createDeliveriesService } from '../src/modules/deliveries/service.js';
import {
  asServices,
  createDbMock,
  createServiceMocks,
  deliveryRow,
  ids,
  renderSql,
  silentLogger,
} from './helpers.js';

function setup() {
  const mock = createDbMock();
  const requeue = vi.fn<DeliveryQueue['requeue']>().mockResolvedValue();
  const service = createDeliveriesService({
    db: mock.db,
    queue: { requeue },
    logger: silentLogger,
  });
  return { ...mock, requeue, service };
}

describe('deliveries service: retry', () => {
  it('resets a FAILED or DEAD delivery to PENDING and requeues it', async () => {
    const { service, queue, callsOf, requeue } = setup();
    queue([deliveryRow({ status: 'PENDING', attempts: 0 })]);

    const result = await service.retry(ids.delivery);

    expect(result).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(callsOf('set')[0]!.args[0]).toEqual({
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: null,
    });
    const { sql, params } = renderSql(callsOf('where')[0]!.args[0]);
    expect(sql).toContain('"deliveries"."status" in ($2, $3)');
    expect(params).toEqual([ids.delivery, 'FAILED', 'DEAD']);
    expect(requeue).toHaveBeenCalledWith(ids.delivery);
  });

  it.each(['PENDING', 'SUCCEEDED'])('refuses to retry a %s delivery', async (status) => {
    const { service, queue, requeue } = setup();
    queue([], [{ status }]);

    const error = await service.retry(ids.delivery).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toContain(status);
    expect(requeue).not.toHaveBeenCalled();
  });

  it('throws NotFound for a missing delivery', async () => {
    const { service, queue } = setup();
    queue([], []);
    await expect(service.retry(ids.missing)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('keeps the delivery PENDING for recovery when requeueing fails', async () => {
    const { service, queue, requeue } = setup();
    queue([deliveryRow()]);
    requeue.mockRejectedValue(new Error('Queue operation timed out'));

    await expect(service.retry(ids.delivery)).resolves.toMatchObject({ status: 'PENDING' });
  });
});

describe('deliveries routes', () => {
  let app: FastifyInstance;
  afterEach(() => app?.close());

  it('answers 202 for an accepted retry', async () => {
    const mocks = createServiceMocks();
    mocks.deliveries.retry.mockResolvedValue(deliveryRow() as never);
    app = await buildApp({ services: asServices(mocks) });

    const res = await app.inject({ method: 'POST', url: `/api/deliveries/${ids.delivery}/retry` });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: ids.delivery, status: 'PENDING' });
  });

  it('answers 409 when the delivery cannot be retried', async () => {
    const mocks = createServiceMocks();
    mocks.deliveries.retry.mockRejectedValue(new ConflictError('Only FAILED or DEAD'));
    app = await buildApp({ services: asServices(mocks) });

    const res = await app.inject({ method: 'POST', url: `/api/deliveries/${ids.delivery}/retry` });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ statusCode: 409, error: 'Conflict' });
  });
});
