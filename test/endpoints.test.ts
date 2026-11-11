import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { UnsafeUrlError, type TargetResolver } from '../src/delivery/url-guard.js';
import { BadRequestError, NotFoundError } from '../src/lib/errors.js';
import { createEndpointsService } from '../src/modules/endpoints/service.js';
import { asServices, createDbMock, createServiceMocks, endpointRow, ids } from './helpers.js';

const SECRET_PATTERN = /^whsec_[A-Za-z0-9_-]{43}$/;

function setup() {
  const mock = createDbMock();
  const resolveTarget = vi.fn<TargetResolver>().mockResolvedValue(undefined);
  const service = createEndpointsService({ db: mock.db, resolveTarget });
  return { ...mock, resolveTarget, service };
}

describe('endpoints service', () => {
  it('creates an endpoint with a generated secret', async () => {
    const { service, queue, callsOf, resolveTarget } = setup();
    queue([endpointRow({ secret: 'whsec_generated' })]);

    const created = await service.create({
      url: 'https://example.com/hooks/orders',
      description: 'Orders',
      eventTypes: ['order.created'],
    });

    const values = callsOf('values')[0]!.args[0] as Record<string, unknown>;
    expect(resolveTarget).toHaveBeenCalledWith('https://example.com/hooks/orders');
    expect(values).toMatchObject({
      url: 'https://example.com/hooks/orders',
      description: 'Orders',
      eventTypes: ['order.created'],
    });
    expect(values.secret).toMatch(SECRET_PATTERN);
    expect(created.secret).toBe('whsec_generated');
  });

  it('rejects private destination urls before touching the database', async () => {
    const { service, resolveTarget, callsOf } = setup();
    resolveTarget.mockRejectedValue(new UnsafeUrlError('Host localhost resolves to a private'));

    await expect(
      service.create({ url: 'http://localhost/hook', eventTypes: [] }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('rotates the secret to a new value', async () => {
    const { service, queue, callsOf } = setup();
    queue([endpointRow({ secret: 'whsec_rotated' })]);

    const rotated = await service.rotateSecret(ids.endpoint);

    const update = callsOf('set')[0]!.args[0] as { secret: string };
    expect(update.secret).toMatch(SECRET_PATTERN);
    expect(update.secret).not.toBe('whsec_existing');
    expect(rotated.secret).toBe('whsec_rotated');
  });

  it('throws NotFound when rotating a missing endpoint', async () => {
    const { service, queue } = setup();
    queue([]);
    await expect(service.rotateSecret(ids.missing)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns delivery stats with zeroes for missing statuses', async () => {
    const { service, queue } = setup();
    const { secret: _secret, ...publicRow } = endpointRow();
    queue(
      [publicRow],
      [
        { status: 'SUCCEEDED', count: 3 },
        { status: 'DEAD', count: 1 },
      ],
    );

    const endpoint = await service.get(ids.endpoint);
    expect(endpoint.stats).toEqual({ PENDING: 0, SUCCEEDED: 3, FAILED: 0, DEAD: 1, total: 4 });
  });
});

describe('endpoints routes', () => {
  let app: FastifyInstance;
  afterEach(() => app?.close());

  const start = async () => {
    const mocks = createServiceMocks();
    app = await buildApp({ services: asServices(mocks) });
    return mocks;
  };

  it('returns the secret on creation', async () => {
    const mocks = await start();
    mocks.endpoints.create.mockResolvedValue(endpointRow({ secret: 'whsec_new' }) as never);

    const res = await app.inject({
      method: 'POST',
      url: '/api/endpoints',
      payload: { url: 'https://example.com/hooks/orders', eventTypes: ['order.created'] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: ids.endpoint, secret: 'whsec_new' });
    expect(mocks.endpoints.create).toHaveBeenCalledWith({
      url: 'https://example.com/hooks/orders',
      eventTypes: ['order.created'],
    });
  });

  it('never exposes the secret in list and detail responses', async () => {
    const mocks = await start();
    mocks.endpoints.list.mockResolvedValue({
      items: [endpointRow()],
      total: 1,
      page: 1,
      limit: 20,
    } as never);
    mocks.endpoints.get.mockResolvedValue({
      ...endpointRow(),
      stats: { PENDING: 0, SUCCEEDED: 0, FAILED: 0, DEAD: 0, total: 0 },
    } as never);

    const list = await app.inject({ method: 'GET', url: '/api/endpoints' });
    const detail = await app.inject({ method: 'GET', url: `/api/endpoints/${ids.endpoint}` });

    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]).not.toHaveProperty('secret');
    expect(list.json()).toMatchObject({ total: 1, page: 1, limit: 20 });
    expect(detail.json()).not.toHaveProperty('secret');
    expect(mocks.endpoints.list).toHaveBeenCalledWith({ page: 1, limit: 20 });
  });

  it('returns the new secret on rotation', async () => {
    const mocks = await start();
    mocks.endpoints.rotateSecret.mockResolvedValue(endpointRow({ secret: 'whsec_next' }) as never);

    const res = await app.inject({
      method: 'POST',
      url: `/api/endpoints/${ids.endpoint}/rotate-secret`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().secret).toBe('whsec_next');
  });

  it.each([
    ['unknown fields', { url: 'https://example.com/a', secret: 'mine' }],
    ['non-http urls', { url: 'ftp://example.com/a' }],
    ['duplicate event types', { url: 'https://example.com/a', eventTypes: ['a.b.c', 'a.b.c'] }],
    [
      'more than 20 event types',
      {
        url: 'https://example.com/a',
        eventTypes: Array.from({ length: 21 }, (_, i) => `type.n${i}`),
      },
    ],
  ])('rejects %s', async (_name, payload) => {
    const mocks = await start();
    const res = await app.inject({ method: 'POST', url: '/api/endpoints', payload });

    expect(res.statusCode).toBe(400);
    expect(mocks.endpoints.create).not.toHaveBeenCalled();
  });

  it.each(['limit=101', 'page=0', 'limit=abc'])('rejects invalid pagination %s', async (query) => {
    await start();
    const res = await app.inject({ method: 'GET', url: `/api/endpoints?${query}` });
    expect(res.statusCode).toBe(400);
  });
});
