import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';

const REF_PREFIX = '#/components/schemas/';

function collectRefs(value: unknown, refs: Set<string>): void {
  JSON.stringify(value, (key, nested: unknown) => {
    if (key === '$ref' && typeof nested === 'string' && nested.startsWith(REF_PREFIX)) {
      refs.add(nested.slice(REF_PREFIX.length));
    }
    return nested;
  });
}

interface OpenApiLike {
  paths?: unknown;
  components?: { schemas?: Record<string, unknown> };
}

export function pruneUnusedSchemas<T extends OpenApiLike>(document: T): T {
  const schemas = document.components?.schemas;
  if (!schemas) return document;

  const used = new Set<string>();
  collectRefs(document.paths, used);
  const queue = [...used];
  while (queue.length > 0) {
    const nested = new Set<string>();
    collectRefs(schemas[queue.pop() as string], nested);
    for (const name of nested) {
      if (!used.has(name)) {
        used.add(name);
        queue.push(name);
      }
    }
  }

  const kept = Object.fromEntries(Object.entries(schemas).filter(([name]) => used.has(name)));
  return { ...document, components: { ...document.components, schemas: kept } };
}

async function swaggerPlugin(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Webhook Relay API',
        description:
          'Register webhook endpoints, publish events and track signed deliveries with retries.',
        version: '1.0.0',
      },
      tags: [
        { name: 'Endpoints', description: 'Webhook destinations' },
        { name: 'Events', description: 'Published events and their fan-out' },
        { name: 'Deliveries', description: 'Delivery status, attempts and manual retries' },
        { name: 'Health', description: 'Service health' },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: (document) => pruneUnusedSchemas(jsonSchemaTransformObject(document)),
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });
}

export default fp(swaggerPlugin, { name: 'swagger' });
