import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HealthService } from './service.js';

const dependencyStatus = z.enum(['up', 'down']);

const healthSchema = z
  .object({
    status: z.enum(['ok', 'error']),
    checks: z.object({ postgres: dependencyStatus, redis: dependencyStatus }),
    failed: z.array(z.string()).describe('Names of unavailable dependencies'),
  })
  .meta({ id: 'Health' });

export const healthRoutes: FastifyPluginAsyncZod<{ service: HealthService }> = async (
  app,
  { service },
) => {
  app.get(
    '/',
    {
      schema: {
        tags: ['Health'],
        summary: 'Check Postgres and Redis connectivity',
        response: { 200: healthSchema, 503: healthSchema },
      },
    },
    async (_request, reply) => {
      const report = await service.check();
      return reply.status(report.status === 'ok' ? 200 : 503).send(report);
    },
  );
};
