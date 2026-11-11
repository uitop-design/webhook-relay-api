import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { healthRoutes } from './modules/health/routes.js';
import type { HealthService } from './modules/health/service.js';
import errorHandler from './plugins/error-handler.js';
import swagger from './plugins/swagger.js';

export const BODY_LIMIT_BYTES = 256 * 1024;

export interface AppServices {
  health: HealthService;
}

export interface BuildAppOptions {
  services: AppServices;
  logger?: FastifyBaseLogger;
}

export async function buildApp({ services, logger }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ...(logger ? { loggerInstance: logger } : { logger: false }),
    bodyLimit: BODY_LIMIT_BYTES,
    routerOptions: { ignoreTrailingSlash: true },
  }).withTypeProvider<ZodTypeProvider>();

  app.removeContentTypeParser('text/plain');
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandler);
  await app.register(swagger);

  await app.register(
    async (api) => {
      await api.register(healthRoutes, { prefix: '/health', service: services.health });
    },
    { prefix: '/api' },
  );

  return app;
}
