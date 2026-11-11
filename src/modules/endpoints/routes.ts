import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idParams, paginationQuery, pickErrors } from '../../lib/schemas.js';
import {
  createEndpointBody,
  endpointDetailsSchema,
  endpointPageSchema,
  endpointSchema,
  endpointWithSecretSchema,
  updateEndpointBody,
} from './schemas.js';
import type { EndpointsService } from './service.js';

const tags = ['Endpoints'];

export const endpointsRoutes: FastifyPluginAsyncZod<{ service: EndpointsService }> = async (
  app,
  { service },
) => {
  app.post(
    '/',
    {
      schema: {
        tags,
        summary: 'Register an endpoint',
        description: 'The signing secret is returned only here and on rotation.',
        body: createEndpointBody,
        response: { 201: endpointWithSecretSchema, ...pickErrors(400, 500) },
      },
    },
    async (request, reply) => reply.status(201).send(await service.create(request.body)),
  );

  app.get(
    '/',
    {
      schema: {
        tags,
        summary: 'List endpoints',
        querystring: paginationQuery,
        response: { 200: endpointPageSchema, ...pickErrors(400, 500) },
      },
    },
    async (request) => service.list(request.query),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags,
        summary: 'Get an endpoint with delivery statistics',
        params: idParams,
        response: { 200: endpointDetailsSchema, ...pickErrors(400, 404, 500) },
      },
    },
    async (request) => service.get(request.params.id),
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags,
        summary: 'Update an endpoint',
        params: idParams,
        body: updateEndpointBody,
        response: { 200: endpointSchema, ...pickErrors(400, 404, 500) },
      },
    },
    async (request) => service.update(request.params.id, request.body),
  );

  app.delete(
    '/:id',
    {
      schema: {
        tags,
        summary: 'Delete an endpoint with its deliveries',
        params: idParams,
        response: { 204: z.undefined().describe('Endpoint deleted'), ...pickErrors(400, 404, 500) },
      },
    },
    async (request, reply) => {
      await service.remove(request.params.id);
      return reply.status(204).send();
    },
  );

  app.post(
    '/:id/rotate-secret',
    {
      schema: {
        tags,
        summary: 'Rotate the signing secret',
        params: idParams,
        response: { 200: endpointWithSecretSchema, ...pickErrors(400, 404, 500) },
      },
    },
    async (request) => service.rotateSecret(request.params.id),
  );
};
