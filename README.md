# Webhook Relay API

A backend service for delivering webhooks. Clients register endpoints and publish events. The service fans every event out to the subscribed endpoints and delivers it as a signed HTTP request, with retries and exponential backoff. You can inspect every attempt and retry failed deliveries by hand.

There is no frontend. The API is documented with Swagger at `/docs`.

## Stack

- **Node.js 24**, **TypeScript** (strict, ESM)
- **Fastify 5** with `fastify-type-provider-zod`, **zod 4** for validation and OpenAPI generation
- **PostgreSQL 18** + **Drizzle ORM** (schema, SQL migrations, seed)
- **BullMQ** + **Redis** (ioredis) for the delivery queue and retries
- **Vitest** for unit tests, **oxlint** + **Prettier** for linting and formatting
- **Docker Compose**: `api`, `worker`, `postgres`, `redis` and a one-off `migrate` job

## Architecture

```
            POST /api/events
client ───────────────────────► api ──┐ 1. one transaction: event + PENDING deliveries
                                      │ 2. after commit: enqueue jobs (jobId = delivery id)
                                      ▼
                               ┌────────────┐            ┌──────────┐
                               │ PostgreSQL │◄──────────►│  worker  │──► POST https://receiver/...
                               └────────────┘            └──────────┘    signed, 5 s timeout
                                      ▲                       ▲
                                      │                       │ BullMQ jobs, backoff
                                      │                  ┌─────────┐
                                      └──── recovery ────│  Redis  │
                                         (every 15 s)    └─────────┘
```

- PostgreSQL is the source of truth (an outbox). An event and its deliveries are written in one transaction, and the queue is only touched after the commit. If Redis is down, `POST /api/events` still returns `202` and the deliveries stay `PENDING`.
- Every 15 seconds the worker re-enqueues `PENDING` deliveries that are older than 15 seconds. This covers a Redis outage or a worker crash, so no delivery is lost. The job id is the delivery id, so a delivery is never queued or processed twice at the same time.
- The API connects to Redis in fail-fast mode (`enableOfflineQueue: false`, connect and command timeouts), so requests do not hang while Redis is unavailable. The worker connection uses `maxRetriesPerRequest: null`, as BullMQ requires.

### Project layout

```
src/
  app.ts                 buildApp() factory (no listen), used by the server and by tests
  server.ts              HTTP server with graceful shutdown
  worker.ts              delivery worker and pending-delivery recovery loop
  config.ts              environment schema (zod), validated at startup
  db/                    Drizzle schema, client, migrate and seed scripts
  delivery/              signing, URL guard, HTTP sender, queue, store, job processor
  modules/<feature>/     routes.ts (thin), service.ts (logic), schemas.ts (zod)
  plugins/               error handler, Swagger
drizzle/                 generated SQL migrations
```

## Data model

| Table               | Columns                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoints`         | `id`, `url`, `description?`, `secret`, `event_types text[]` (empty = all events), `active`, `created_at`, `updated_at`                                                                                                                  |
| `events`            | `id`, `type`, `payload jsonb`, `created_at`                                                                                                                                                                                             |
| `deliveries`        | `id`, `event_id → events` (cascade), `endpoint_id → endpoints` (cascade), `status`, `attempts`, `next_attempt_at?`, `last_status_code?`, `last_error?`, timestamps; unique `(event_id, endpoint_id)`, index `(status, next_attempt_at)` |
| `delivery_attempts` | `id`, `delivery_id → deliveries` (cascade), `attempt_no`, `status_code?`, `duration_ms`, `error?` (up to 500 characters), `created_at`                                                                                                  |

The service never stores response bodies from receivers.

## Delivery lifecycle

```
PENDING ──2xx──► SUCCEEDED
   │
   ├─ non-2xx / network error / timeout ──► FAILED (next_attempt_at set) ──retry──► …
   │                                          └─ after MAX_ATTEMPTS ──► DEAD
   ├─ 410 Gone ──► DEAD + endpoint deactivated
   └─ endpoint inactive ──► DEAD (nothing is sent)

FAILED / DEAD ──POST /api/deliveries/:id/retry──► PENDING (attempts reset)
```

- **Retries.** The delay before retry _n_ is `RETRY_BASE_MS × 2^(n-1)`, which gives 2 s, 4 s, 8 s and 16 s with the defaults. BullMQ schedules the retries through a custom backoff strategy. After `MAX_ATTEMPTS` attempts (5 by default) the delivery becomes `DEAD`.
- **Timeouts and redirects.** A request that takes longer than `DELIVERY_TIMEOUT_MS` (5 s) counts as a failed attempt. Redirects are not followed, so a `3xx` response also counts as a failure.
- **Deactivated endpoints.** An inactive endpoint gets no new deliveries. Jobs that were already queued for it end as `DEAD` without sending anything.
- **Manual retry.** Only `FAILED` and `DEAD` deliveries can be retried. Any other status returns `409`.

## Webhook request format

```http
POST /your/hook HTTP/1.1
Content-Type: application/json
User-Agent: webhook-relay/1.0
X-Webhook-Id: 3f0b6a1e-…            # delivery id; stable across retries, use it for idempotency
X-Webhook-Event: order.created
X-Webhook-Timestamp: 1794900000     # unix seconds
X-Webhook-Signature: v1=5d41402abc4b2a76b9719d911017c592…

{"id":"<event id>","type":"order.created","createdAt":"2026-11-11T12:00:00.000Z","payload":{…}}
```

The signature is `v1=` followed by the hex-encoded HMAC-SHA256 of `${timestamp}.${rawBody}`, keyed with the endpoint secret (the full `whsec_…` string).

### Verifying a signature (Node.js)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const SECRET = process.env.WEBHOOK_SECRET; // whsec_...
const TOLERANCE_SECONDS = 300;

function isValid(rawBody, timestamp, signature) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected =
    'v1=' + createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const ok = isValid(
        raw,
        req.headers['x-webhook-timestamp'],
        req.headers['x-webhook-signature'],
      );
      res.writeHead(ok ? 200 : 401).end();
    });
  })
  .listen(8080);
```

Compute the HMAC over the **raw** request body. Parsing the JSON and serializing it again can change the bytes and break the signature.

## API

All routes have the `/api` prefix. Swagger UI is at **http://localhost:3500/docs** and the OpenAPI JSON at `/docs/json`.

| Method   | Path                               | Description                                                                          |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `POST`   | `/api/endpoints`                   | Register an endpoint `{ url, description?, eventTypes? }` → `201`, includes `secret` |
| `GET`    | `/api/endpoints`                   | List endpoints (`page`, `limit`), without secrets                                    |
| `GET`    | `/api/endpoints/:id`               | Endpoint with delivery counts by status                                              |
| `PATCH`  | `/api/endpoints/:id`               | Update `url`, `description`, `eventTypes`, `active`                                  |
| `DELETE` | `/api/endpoints/:id`               | Delete an endpoint and its deliveries → `204`                                        |
| `POST`   | `/api/endpoints/:id/rotate-secret` | Issue a new secret; later deliveries are signed with it                              |
| `POST`   | `/api/events`                      | Publish `{ type, payload }` → `202 { event, deliveries }`                            |
| `GET`    | `/api/events`                      | List events (`page`, `limit`, `type`)                                                |
| `GET`    | `/api/events/:id`                  | Event with its deliveries                                                            |
| `GET`    | `/api/deliveries`                  | List deliveries (`page`, `limit`, `status`, `endpointId`, `eventId`)                 |
| `GET`    | `/api/deliveries/:id`              | Delivery with `attemptHistory`                                                       |
| `POST`   | `/api/deliveries/:id/retry`        | Retry a `FAILED` or `DEAD` delivery → `202`; any other status → `409`                |
| `GET`    | `/api/health`                      | Postgres and Redis status; `503` and the `failed` list when a dependency is down     |

### Validation rules

- `url`: `http` or `https`, up to 2048 characters. The host must not resolve to a private, loopback, link-local or otherwise reserved address. The check runs when the endpoint is saved and again before every delivery, and the request is sent to the IP address that passed the check. Set `ALLOW_PRIVATE_URLS=true` to turn the check off for local development.
- `type`, `eventTypes[]`: `[a-z0-9_.-]`, 3–64 characters. `eventTypes` holds up to 20 unique values.
- `payload`: a JSON object (arrays and `null` are rejected), at most 64 KB when serialized.
- Pagination: `page` ≥ 1, `limit` between 1 and 100 (20 by default). Unknown body fields are rejected.

### Errors

Every error uses the same shape:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["body.url: Must be a valid http(s) URL"],
  "path": "/api/endpoints",
  "timestamp": "2026-11-11T12:00:00.000Z"
}
```

Validation errors return `400` with a list of messages. Malformed JSON returns `400`, an oversized body `413` and an unsupported content type `415`. Postgres unique violations map to `409`, and foreign key and invalid-input errors to `400`. Any unexpected error returns `500` with a generic message, and the details go only to the log.

## Configuration

| Variable               | Default            | Description                                                                    |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `NODE_ENV`             | `development`      | `development` enables pretty logs                                              |
| `HOST` / `PORT`        | `0.0.0.0` / `3500` | HTTP listen address                                                            |
| `LOG_LEVEL`            | `info`             | pino log level                                                                 |
| `DATABASE_URL`         | –                  | PostgreSQL connection string                                                   |
| `REDIS_URL`            | –                  | Redis connection string                                                        |
| `ALLOW_PRIVATE_URLS`   | `false`            | Allow endpoints on private or loopback addresses                               |
| `MAX_ATTEMPTS`         | `5`                | Attempts before a delivery becomes `DEAD`                                      |
| `RETRY_BASE_MS`        | `2000`             | Base delay for exponential backoff                                             |
| `DELIVERY_TIMEOUT_MS`  | `5000`             | Timeout for each delivery request                                              |
| `WORKER_CONCURRENCY`   | `10`               | Deliveries processed in parallel by one worker                                 |
| `RECOVERY_INTERVAL_MS` | `15000`            | How often stale `PENDING` deliveries are re-enqueued, and how old they must be |

The app validates its configuration at startup and exits with a readable error if a value is invalid.

## Running

### Docker Compose

```bash
docker compose up -d --build
```

This starts PostgreSQL (host port `5438`) and Redis (`6383`), then runs migrations and the seed once, then starts the API on **http://localhost:3500** and the worker. The compose file sets `ALLOW_PRIVATE_URLS=true` so you can try the service against a receiver on your machine through `http://host.docker.internal:<port>`. Retry settings can be changed through environment variables, for example `RETRY_BASE_MS=200 docker compose up -d`.

The seed adds three endpoints on `https://example.com/hooks/...` and three events whose deliveries are in `SUCCEEDED`, `FAILED` and `DEAD` states. It writes these rows straight into the database and sends nothing.

### Local development

```bash
npm install
cp .env.example .env
docker compose up -d postgres redis
npm run db:migrate
npm run db:seed
npm run dev          # API with tsx watch
npm run dev:worker   # worker with tsx watch
```

### Scripts

| Script                       | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `npm run build`              | Compile TypeScript to `dist/`                      |
| `npm start` / `start:worker` | Run the compiled API or worker                     |
| `npm run typecheck`          | `tsc --noEmit`                                     |
| `npm run lint`               | oxlint + Prettier check                            |
| `npm run format`             | Format the code with Prettier                      |
| `npm test`                   | Unit tests (Vitest)                                |
| `npm run db:generate`        | Generate a migration from the schema (drizzle-kit) |
| `npm run db:migrate`         | Apply migrations                                   |
| `npm run db:seed`            | Seed demo data (idempotent)                        |

## Tests

```bash
npm test
```

The unit tests mock the database, the queue and outbound HTTP. They cover signing (including a known test vector), endpoint creation and secret rotation, event fan-out, the delivery processor (success, retry, `DEAD`, `410`, timeout), manual retry rules, private address detection and the error handler. HTTP-level tests run the real app through `app.inject()`.

## License

MIT
