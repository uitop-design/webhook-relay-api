import { describe, expect, it } from 'vitest';
import {
  buildWebhookHeaders,
  generateSecret,
  sign,
  verifySignature,
} from '../src/delivery/signature.js';

const SECRET = 'whsec_test_secret';
const TIMESTAMP = 1700000000;
const BODY = '{"id":"evt_1","type":"order.created"}';
const KNOWN_SIGNATURE = 'v1=479d263a26872ce2aeda9f217b43b4c9870314fba787aeb383c38d7c7a296e24';

describe('signature', () => {
  it('matches a known HMAC-SHA256 test vector', () => {
    expect(sign(SECRET, TIMESTAMP, BODY)).toBe(KNOWN_SIGNATURE);
  });

  it('uses the v1=<64 hex chars> format', () => {
    expect(sign('whsec_other', 1, '{}')).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('changes when the timestamp, body or secret change', () => {
    expect(sign(SECRET, TIMESTAMP + 1, BODY)).not.toBe(KNOWN_SIGNATURE);
    expect(sign(SECRET, TIMESTAMP, `${BODY} `)).not.toBe(KNOWN_SIGNATURE);
    expect(sign(`${SECRET}x`, TIMESTAMP, BODY)).not.toBe(KNOWN_SIGNATURE);
  });

  it('verifies valid signatures and rejects tampered ones', () => {
    expect(verifySignature(SECRET, TIMESTAMP, BODY, KNOWN_SIGNATURE)).toBe(true);
    expect(verifySignature(SECRET, TIMESTAMP, BODY, KNOWN_SIGNATURE.replace(/.$/, '0'))).toBe(
      false,
    );
    expect(verifySignature(SECRET, TIMESTAMP, BODY, 'v1=short')).toBe(false);
  });

  it('generates whsec_ secrets from 32 random bytes in base64url', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret.slice('whsec_'.length), 'base64url')).toHaveLength(32);
    expect(generateSecret()).not.toBe(secret);
  });

  it('builds all webhook headers', () => {
    const headers = buildWebhookHeaders({
      deliveryId: 'dlv_1',
      eventType: 'order.created',
      timestamp: TIMESTAMP,
      secret: SECRET,
      rawBody: BODY,
    });
    expect(headers).toMatchObject({
      'content-type': 'application/json',
      'x-webhook-id': 'dlv_1',
      'x-webhook-event': 'order.created',
      'x-webhook-timestamp': String(TIMESTAMP),
      'x-webhook-signature': KNOWN_SIGNATURE,
    });
  });
});
