import { count, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { DELIVERY_STATUSES, deliveries, endpoints, type EndpointRow } from '../../db/schema.js';
import { generateSecret } from '../../delivery/signature.js';
import { UnsafeUrlError, type TargetResolver } from '../../delivery/url-guard.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { offsetOf, type Page, type Pagination } from '../../lib/schemas.js';
import type { CreateEndpointInput, DeliveryStats, UpdateEndpointInput } from './schemas.js';

export type Endpoint = Omit<EndpointRow, 'secret'>;

const publicColumns = {
  id: endpoints.id,
  url: endpoints.url,
  description: endpoints.description,
  eventTypes: endpoints.eventTypes,
  active: endpoints.active,
  createdAt: endpoints.createdAt,
  updatedAt: endpoints.updatedAt,
};

export interface EndpointsServiceDeps {
  db: Database;
  resolveTarget: TargetResolver;
}

export function createEndpointsService({ db, resolveTarget }: EndpointsServiceDeps) {
  async function assertUrlAllowed(url: string): Promise<void> {
    try {
      await resolveTarget(url);
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        throw new BadRequestError(`url: ${error.message}`);
      }
      throw error;
    }
  }

  async function stats(endpointId: string): Promise<DeliveryStats> {
    const rows = await db
      .select({ status: deliveries.status, count: count() })
      .from(deliveries)
      .where(eq(deliveries.endpointId, endpointId))
      .groupBy(deliveries.status);

    const result = Object.fromEntries(DELIVERY_STATUSES.map((status) => [status, 0])) as Omit<
      DeliveryStats,
      'total'
    >;
    for (const row of rows) result[row.status] = row.count;
    return { ...result, total: rows.reduce((sum, row) => sum + row.count, 0) };
  }

  return {
    async create(input: CreateEndpointInput): Promise<EndpointRow> {
      await assertUrlAllowed(input.url);
      const [row] = await db
        .insert(endpoints)
        .values({
          url: input.url,
          description: input.description ?? null,
          eventTypes: input.eventTypes,
          secret: generateSecret(),
        })
        .returning();
      return row!;
    },

    async list(pagination: Pagination): Promise<Page<Endpoint>> {
      const [items, [totals]] = await Promise.all([
        db
          .select(publicColumns)
          .from(endpoints)
          .orderBy(desc(endpoints.createdAt), desc(endpoints.id))
          .limit(pagination.limit)
          .offset(offsetOf(pagination)),
        db.select({ total: count() }).from(endpoints),
      ]);
      return { items, total: totals?.total ?? 0, ...pagination };
    },

    async get(id: string): Promise<Endpoint & { stats: DeliveryStats }> {
      const [row] = await db.select(publicColumns).from(endpoints).where(eq(endpoints.id, id));
      if (!row) throw new NotFoundError('Endpoint');
      return { ...row, stats: await stats(id) };
    },

    async update(id: string, input: UpdateEndpointInput): Promise<Endpoint> {
      if (input.url !== undefined) await assertUrlAllowed(input.url);
      const [row] = await db
        .update(endpoints)
        .set({
          url: input.url,
          description: input.description,
          eventTypes: input.eventTypes,
          active: input.active,
        })
        .where(eq(endpoints.id, id))
        .returning(publicColumns);
      if (!row) throw new NotFoundError('Endpoint');
      return row;
    },

    async remove(id: string): Promise<void> {
      const [row] = await db
        .delete(endpoints)
        .where(eq(endpoints.id, id))
        .returning({ id: endpoints.id });
      if (!row) throw new NotFoundError('Endpoint');
    },

    async rotateSecret(id: string): Promise<EndpointRow> {
      const [row] = await db
        .update(endpoints)
        .set({ secret: generateSecret() })
        .where(eq(endpoints.id, id))
        .returning();
      if (!row) throw new NotFoundError('Endpoint');
      return row;
    },
  };
}

export type EndpointsService = ReturnType<typeof createEndpointsService>;
