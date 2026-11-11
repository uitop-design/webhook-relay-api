import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SECRET_PREFIX = 'whsec_';
export const SIGNATURE_VERSION = 'v1';

export function generateSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function sign(secret: string, timestamp: number, rawBody: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `${SIGNATURE_VERSION}=${digest}`;
}

export function verifySignature(
  secret: string,
  timestamp: number,
  rawBody: string,
  signature: string,
): boolean {
  const expected = Buffer.from(sign(secret, timestamp, rawBody));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface WebhookHeadersInput {
  deliveryId: string;
  eventType: string;
  timestamp: number;
  secret: string;
  rawBody: string;
}

export function buildWebhookHeaders(input: WebhookHeadersInput): Record<string, string> {
  return {
    'content-type': 'application/json',
    'user-agent': 'webhook-relay/1.0',
    'x-webhook-id': input.deliveryId,
    'x-webhook-event': input.eventType,
    'x-webhook-timestamp': String(input.timestamp),
    'x-webhook-signature': sign(input.secret, input.timestamp, input.rawBody),
  };
}
