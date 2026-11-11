import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { ConflictError, NotFoundError } from '../src/lib/errors.js';
import errorHandler, { pgErrorCode } from '../src/plugins/error-handler.js';
import { asServices, createServiceMocks } from './helpers.js';

class DatabaseError extends Error {
  constructor(readonly code: string) {
    super(`pg error ${code}: duplicate key value violates "secret_internal_idx"`);
  }
}

class DrizzleQueryError extends Error {
  constructor(cause: Error) {
    super('Failed query: insert into "endpoints" ...', { cause });
  }
}

let app: FastifyInstance;
afterEach(() => app?.close());

async function testApp(error?: Error) {
  app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorHandler);
  app.post(
    '/items',
    { schema: { body: z.strictObject({ name: z.string().min(2), count: z.number().int() }) } },
    async () => {
      if (error) throw error;
      return { ok: true };
    },
  );
  return app;
}

const expectErrorShape = (body: Record<string, unknown>, statusCode: number, error: string) => {
  expect(body).toEqual({
    statusCode,
    error,
    message: expect.anything(),
    path: '/items',
    timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  });
};

describe('error handler', () => {
  it('returns 400 with a list of field messages for validation errors', async () => {
    await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { name: 'x', extra: 1 },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expectErrorShape(body, 400, 'Bad Request');
    expect(body.message).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^body\.name: /),
        expect.stringMatching(/^body\.count: /),
        expect.stringMatching(/^body: Unrecognized key/),
      ]),
    );
  });

  it('keeps body parser errors in the same format', async () => {
    await testApp();
    const malformed = await app.inject({
      method: 'POST',
      url: '/items',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(malformed.statusCode).toBe(400);
    expectErrorShape(malformed.json(), 400, 'Bad Request');

    const unsupported = await app.inject({
      method: 'POST',
      url: '/items',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(unsupported.statusCode).toBe(415);
    expectErrorShape(unsupported.json(), 415, 'Unsupported Media Type');
  });

  it.each([
    [new NotFoundError('Endpoint'), 404, 'Not Found', 'Endpoint not found'],
    [new ConflictError('Already retried'), 409, 'Conflict', 'Already retried'],
  ])('maps application errors (%s)', async (error, status, name, message) => {
    await testApp(error);
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { name: 'ok', count: 1 },
    });

    expect(res.statusCode).toBe(status);
    expectErrorShape(res.json(), status, name);
    expect(res.json().message).toBe(message);
  });

  it.each([
    ['23505', 409, 'Conflict'],
    ['23503', 400, 'Bad Request'],
    ['22P02', 400, 'Bad Request'],
  ])('maps postgres error %s wrapped by drizzle to %i', async (code, status, name) => {
    await testApp(new DrizzleQueryError(new DatabaseError(code)));
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { name: 'ok', count: 1 },
    });

    expect(res.statusCode).toBe(status);
    expectErrorShape(res.json(), status, name);
    expect(res.json().message).not.toContain('secret_internal_idx');
  });

  it('hides details of unexpected errors behind a generic 500', async () => {
    await testApp(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { name: 'ok', count: 1 },
    });

    expect(res.statusCode).toBe(500);
    expectErrorShape(res.json(), 500, 'Internal Server Error');
    expect(res.json().message).toBe('Internal Server Error');
    expect(res.body).not.toContain('ECONNREFUSED');
    expect(res.body).not.toContain('hunter2');
  });

  it('formats unknown routes as 404', async () => {
    await testApp();
    const res = await app.inject({ method: 'GET', url: '/missing?x=1' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      message: 'Route GET /missing not found',
      path: '/missing?x=1',
    });
  });
});

describe('pgErrorCode', () => {
  it('finds SQLSTATE codes in the error or its causes', () => {
    expect(pgErrorCode(new DatabaseError('23505'))).toBe('23505');
    expect(pgErrorCode(new DrizzleQueryError(new DatabaseError('23503')))).toBe('23503');
    expect(pgErrorCode(Object.assign(new Error('fs'), { code: 'ENOENT' }))).toBeUndefined();
    expect(pgErrorCode('not an error')).toBeUndefined();
  });
});

describe('health route', () => {
  it('returns 503 with the name of the failed dependency', async () => {
    const mocks = createServiceMocks();
    mocks.health.check.mockResolvedValue({
      status: 'error',
      checks: { postgres: 'up', redis: 'down' },
      failed: ['redis'],
    });
    app = await buildApp({ services: asServices(mocks) });

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'error',
      checks: { postgres: 'up', redis: 'down' },
      failed: ['redis'],
    });
  });
});
