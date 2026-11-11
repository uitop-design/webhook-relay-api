import { describe, expect, it, vi } from 'vitest';
import type { DeliveryQueue } from '../src/delivery/queue.js';
import { NotFoundError } from '../src/lib/errors.js';
import { createEventsService } from '../src/modules/events/service.js';
import { createDbMock, eventRow, ids, renderSql, silentLogger } from './helpers.js';

function setup() {
  const mock = createDbMock();
  const enqueue = vi.fn<DeliveryQueue['enqueue']>().mockResolvedValue();
  const service = createEventsService({ db: mock.db, queue: { enqueue }, logger: silentLogger });
  return { ...mock, enqueue, service };
}

const input = { type: 'order.created', payload: { orderId: 42 } };

describe('events service: publish', () => {
  it('creates a delivery for every subscribed endpoint and enqueues them after commit', async () => {
    const { service, queue, callsOf, enqueue } = setup();
    queue([eventRow()], [{ id: 'ep-1' }, { id: 'ep-2' }], [{ id: 'dlv-1' }, { id: 'dlv-2' }]);

    const result = await service.publish(input);

    expect(result).toEqual({ event: eventRow(), deliveries: 2 });
    expect(callsOf('values')[1]!.args[0]).toEqual([
      { eventId: ids.event, endpointId: 'ep-1' },
      { eventId: ids.event, endpointId: 'ep-2' },
    ]);
    expect(enqueue).toHaveBeenCalledWith(['dlv-1', 'dlv-2']);
  });

  it('selects only active endpoints subscribed to the type or to all events', async () => {
    const { service, queue, callsOf } = setup();
    queue([eventRow()], []);

    await service.publish(input);

    const { sql, params } = renderSql(callsOf('where')[0]!.args[0]);
    expect(sql).toContain('"endpoints"."active" = $1');
    expect(sql).toContain('cardinality("endpoints"."event_types") = 0');
    expect(sql).toContain('"endpoints"."event_types" @> $2');
    expect(params).toEqual([true, '{"order.created"}']);
  });

  it('creates no deliveries when nobody is subscribed', async () => {
    const { service, queue, callsOf, enqueue } = setup();
    queue([eventRow()], []);

    await expect(service.publish(input)).resolves.toMatchObject({ deliveries: 0 });
    expect(callsOf('insert')).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledWith([]);
  });

  it('still succeeds when the queue is unavailable', async () => {
    const { service, queue, enqueue } = setup();
    queue([eventRow()], [{ id: 'ep-1' }], [{ id: 'dlv-1' }]);
    enqueue.mockRejectedValue(new Error('Stream is not writeable'));

    await expect(service.publish(input)).resolves.toMatchObject({ deliveries: 1 });
  });

  it('does not enqueue anything when the transaction fails', async () => {
    const { service, queue, enqueue } = setup();
    queue([eventRow()], new Error('connection terminated'));

    await expect(service.publish(input)).rejects.toThrow('connection terminated');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('events service: get', () => {
  it('throws NotFound for a missing event', async () => {
    const { service, queue } = setup();
    queue([]);
    await expect(service.get(ids.missing)).rejects.toBeInstanceOf(NotFoundError);
  });
});
