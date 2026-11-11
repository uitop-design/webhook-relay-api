import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

const PG_ERRORS: Record<string, { statusCode: number; message: string }> = {
  '23505': { statusCode: 409, message: 'Resource already exists' },
  '23503': { statusCode: 400, message: 'Referenced resource does not exist' },
  '22P02': { statusCode: 400, message: 'Invalid input syntax' },
};

export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }
    current = current.cause;
  }
  return undefined;
}

function body(statusCode: number, message: string | string[], request: FastifyRequest): ErrorBody {
  return {
    statusCode,
    error: STATUS_CODES[statusCode] ?? 'Error',
    message,
    path: request.url,
    timestamp: new Date().toISOString(),
  };
}

function formatPath(instancePath: string, context: string | undefined): string {
  const scope = context === 'querystring' ? 'query' : (context ?? 'request');
  const segments = instancePath.split('/').filter(Boolean);
  return [scope, ...segments].join('.');
}

export function resolveError(error: FastifyError | Error, request: FastifyRequest): ErrorBody {
  if (hasZodFastifySchemaValidationErrors(error)) {
    const messages = error.validation.map((issue) => {
      return `${formatPath(issue.instancePath, error.validationContext)}: ${issue.message}`;
    });
    return body(400, messages, request);
  }

  if (error instanceof AppError) {
    return body(error.statusCode, error.message, request);
  }

  const pgCode = pgErrorCode(error);
  const pgError = pgCode ? PG_ERRORS[pgCode] : undefined;
  if (pgError) {
    return body(pgError.statusCode, pgError.message, request);
  }

  const statusCode = (error as FastifyError).statusCode;
  if (
    !isResponseSerializationError(error) &&
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
  ) {
    return body(statusCode, error.message, request);
  }

  return body(500, 'Internal Server Error', request);
}

async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const payload = resolveError(error, request);
    if (payload.statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
    } else {
      request.log.info(
        { statusCode: payload.statusCode, reason: payload.message },
        'Request rejected',
      );
    }
    return reply.status(payload.statusCode).send(payload);
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .status(404)
      .send(body(404, `Route ${request.method} ${request.url.split('?')[0]} not found`, request));
  });
}

export default fp(errorHandlerPlugin, { name: 'error-handler' });
