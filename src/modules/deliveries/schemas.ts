import { z } from 'zod';
import { DELIVERY_STATUSES } from '../../db/schema.js';
import { dateTime, paginated, paginationQuery } from '../../lib/schemas.js';

export const deliveryStatus = z.enum(DELIVERY_STATUSES).describe('Delivery status');

export const deliverySchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid(),
    endpointId: z.uuid(),
    status: deliveryStatus,
    attempts: z.number().int().describe('Attempts made in the current delivery cycle'),
    nextAttemptAt: dateTime.nullable().describe('When the next retry is scheduled'),
    lastStatusCode: z.number().int().nullable(),
    lastError: z.string().nullable(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'Delivery' });

export const deliveryAttemptSchema = z
  .object({
    id: z.uuid(),
    attemptNo: z.number().int(),
    statusCode: z.number().int().nullable(),
    durationMs: z.number().int(),
    error: z.string().nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'DeliveryAttempt' });

export const deliveryDetailsSchema = deliverySchema
  .extend({ attemptHistory: z.array(deliveryAttemptSchema) })
  .meta({ id: 'DeliveryDetails' });

export const deliveryPageSchema = paginated(deliverySchema).meta({ id: 'DeliveryPage' });

export const deliveriesQuery = paginationQuery.extend({
  status: deliveryStatus.optional(),
  endpointId: z.uuid().optional(),
  eventId: z.uuid().optional(),
});

export type DeliveriesQuery = z.infer<typeof deliveriesQuery>;
