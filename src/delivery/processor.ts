import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { WebhookSender } from './sender.js';
import { buildWebhookHeaders } from './signature.js';
import type { AttemptRecord, DeliveryStore } from './store.js';
import type { TargetResolver } from './url-guard.js';

export const MAX_ERROR_LENGTH = 500;

export type DeliveryOutcome = 'SUCCEEDED' | 'FAILED' | 'DEAD' | 'SKIPPED';

export class RetryDeliveryError extends Error {
  constructor(
    message: string,
    readonly delayMs: number,
  ) {
    super(message);
    this.name = 'RetryDeliveryError';
  }
}

export function retryDelay(attemptNo: number, baseMs: number): number {
  return baseMs * 2 ** Math.max(0, attemptNo - 1);
}

export function truncateError(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? message.slice(0, MAX_ERROR_LENGTH) : message;
}

export interface JobAttemptInfo {
  attemptsMade: number;
  maxAttempts: number;
}

export interface ProcessorDeps {
  store: DeliveryStore;
  send: WebhookSender;
  resolveTarget: TargetResolver;
  config: Pick<Config, 'MAX_ATTEMPTS' | 'RETRY_BASE_MS' | 'DELIVERY_TIMEOUT_MS'>;
  logger: Logger;
  now?: () => Date;
}

export function createDeliveryProcessor({
  store,
  send,
  resolveTarget,
  config,
  logger,
  now = () => new Date(),
}: ProcessorDeps) {
  return async function processDelivery(
    deliveryId: string,
    job: JobAttemptInfo,
  ): Promise<DeliveryOutcome> {
    const context = await store.load(deliveryId);
    if (!context || context.delivery.status === 'SUCCEEDED' || context.delivery.status === 'DEAD') {
      return 'SKIPPED';
    }

    const { delivery, endpoint, event } = context;
    if (!endpoint.active) {
      await store.markDead(deliveryId, 'Endpoint is inactive');
      logger.info({ deliveryId, endpointId: endpoint.id }, 'Delivery dropped: endpoint inactive');
      return 'DEAD';
    }

    const attemptNo = delivery.attempts + 1;
    const startedAt = now();
    const timestamp = Math.floor(startedAt.getTime() / 1000);
    const rawBody = JSON.stringify({
      id: event.id,
      type: event.type,
      createdAt: event.createdAt.toISOString(),
      payload: event.payload,
    });

    let result;
    try {
      const addresses = await resolveTarget(endpoint.url);
      result = await send({
        url: endpoint.url,
        body: rawBody,
        timeoutMs: config.DELIVERY_TIMEOUT_MS,
        headers: buildWebhookHeaders({
          deliveryId,
          eventType: event.type,
          timestamp,
          secret: endpoint.secret,
          rawBody,
        }),
        ...(addresses ? { addresses } : {}),
      });
    } catch (error) {
      result = {
        statusCode: null,
        durationMs: now().getTime() - startedAt.getTime(),
        error: error instanceof Error ? error.message : 'Delivery failed',
      };
    }

    const { statusCode, durationMs } = result;
    const succeeded = statusCode !== null && statusCode >= 200 && statusCode < 300;
    const gone = statusCode === 410;
    const error = succeeded
      ? null
      : truncateError(result.error ?? `Endpoint responded with status ${statusCode}`);
    const exhausted = attemptNo >= config.MAX_ATTEMPTS || job.attemptsMade + 1 >= job.maxAttempts;

    const record: AttemptRecord = {
      deliveryId,
      attemptNo,
      statusCode,
      durationMs,
      error,
      status: 'SUCCEEDED',
      nextAttemptAt: null,
    };

    const removed = () => {
      logger.info({ deliveryId }, 'Delivery was deleted during the attempt');
      return 'SKIPPED' as const;
    };

    if (succeeded) {
      if (!(await store.recordAttempt(record))) return removed();
      logger.info({ deliveryId, attemptNo, statusCode }, 'Delivery succeeded');
      return 'SUCCEEDED';
    }

    if (gone || exhausted) {
      const saved = await store.recordAttempt({
        ...record,
        status: 'DEAD',
        ...(gone ? { deactivateEndpointId: endpoint.id } : {}),
      });
      if (!saved) return removed();
      logger.warn(
        { deliveryId, attemptNo, statusCode, endpointId: endpoint.id, gone },
        gone ? 'Endpoint is gone, deactivated' : 'Delivery exhausted retries',
      );
      return 'DEAD';
    }

    const delayMs = retryDelay(attemptNo, config.RETRY_BASE_MS);
    const saved = await store.recordAttempt({
      ...record,
      status: 'FAILED',
      nextAttemptAt: new Date(now().getTime() + delayMs),
    });
    if (!saved) return removed();
    logger.info({ deliveryId, attemptNo, statusCode, delayMs }, 'Delivery failed, retry scheduled');
    throw new RetryDeliveryError(error ?? 'Delivery failed', delayMs);
  };
}

export type DeliveryProcessor = ReturnType<typeof createDeliveryProcessor>;
