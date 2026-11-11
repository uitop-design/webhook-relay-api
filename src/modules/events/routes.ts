import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParams, pickErrors } from '../../lib/schemas.js';
import {
  eventDetailsSchema,
  eventPageSchema,
  eventsQuery,
  publishedEventSchema,
  publishEventBody,
} from './schemas.js';
import type { EventsService } from './service.js';

const tags = ['Events'];

export const eventsRoutes: FastifyPluginAsyncZod<{ service: EventsService }> = async (
  app,
  { service },
) => {
  app.post(
    '/',
    {
      schema: {
        tags,
        summary: 'Publish an event',
        description:
          'Stores the event and creates a delivery for every active endpoint subscribed to its type. Deliveries are processed asynchronously.',
        body: publishEventBody,
        response: { 202: publishedEventSchema, ...pickErrors(400, 500) },
      },
    },
    async (request, reply) => reply.status(202).send(await service.publish(request.body)),
  );

  app.get(
    '/',
    {
      schema: {
        tags,
        summary: 'List events',
        querystring: eventsQuery,
        response: { 200: eventPageSchema, ...pickErrors(400, 500) },
      },
    },
    async (request) => service.list(request.query),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags,
        summary: 'Get an event with its deliveries',
        params: idParams,
        response: { 200: eventDetailsSchema, ...pickErrors(400, 404, 500) },
      },
    },
    async (request) => service.get(request.params.id),
  );
};
