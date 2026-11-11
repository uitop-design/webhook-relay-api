import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParams, pickErrors } from '../../lib/schemas.js';
import {
  deliveriesQuery,
  deliveryDetailsSchema,
  deliveryPageSchema,
  deliverySchema,
} from './schemas.js';
import type { DeliveriesService } from './service.js';

const tags = ['Deliveries'];

export const deliveriesRoutes: FastifyPluginAsyncZod<{ service: DeliveriesService }> = async (
  app,
  { service },
) => {
  app.get(
    '/',
    {
      schema: {
        tags,
        summary: 'List deliveries',
        querystring: deliveriesQuery,
        response: { 200: deliveryPageSchema, ...pickErrors(400, 500) },
      },
    },
    async (request) => service.list(request.query),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags,
        summary: 'Get a delivery with its attempt history',
        params: idParams,
        response: { 200: deliveryDetailsSchema, ...pickErrors(400, 404, 500) },
      },
    },
    async (request) => service.get(request.params.id),
  );

  app.post(
    '/:id/retry',
    {
      schema: {
        tags,
        summary: 'Retry a FAILED or DEAD delivery',
        description: 'Resets the attempt counter and puts the delivery back into the queue.',
        params: idParams,
        response: { 202: deliverySchema, ...pickErrors(400, 404, 409, 500) },
      },
    },
    async (request, reply) => reply.status(202).send(await service.retry(request.params.id)),
  );
};
