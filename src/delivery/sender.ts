import http from 'node:http';
import https from 'node:https';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';

export interface SendRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  addresses?: LookupAddress[];
}

export interface SendResult {
  statusCode: number | null;
  durationMs: number;
  error: string | null;
}

export type WebhookSender = (request: SendRequest) => Promise<SendResult>;

function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const [first] = addresses;
    if (options.all) {
      callback(null, addresses);
    } else if (first) {
      callback(null, first.address, first.family);
    }
  };
}

function describeError(error: NodeJS.ErrnoException): string {
  return error.message || error.code || 'Request failed';
}

export const sendWebhook: WebhookSender = (request) => {
  const target = new URL(request.url);
  const transport = target.protocol === 'https:' ? https : http;
  const startedAt = performance.now();

  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const finish = (statusCode: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      resolve({ statusCode, durationMs: Math.round(performance.now() - startedAt), error });
    };

    const req = transport.request(target, {
      method: 'POST',
      agent: false,
      headers: { ...request.headers, 'content-length': Buffer.byteLength(request.body) },
      ...(request.addresses ? { lookup: pinnedLookup(request.addresses) } : {}),
    });

    const timer = setTimeout(() => {
      finish(null, `Request timed out after ${request.timeoutMs} ms`);
      req.destroy();
    }, request.timeoutMs);

    req.on('response', (res) => {
      finish(res.statusCode ?? null, null);
      res.on('error', () => undefined);
      res.resume();
    });
    req.on('error', (error) => finish(null, describeError(error)));
    req.on('close', () => clearTimeout(timer));
    req.end(request.body);
  });
};
