import { z } from 'zod';
import { dateTime, paginated } from '../../lib/schemas.js';

export const EVENT_TYPE_PATTERN = /^[a-z0-9_.-]{3,64}$/;
export const MAX_EVENT_TYPES = 20;

export const eventType = z
  .string()
  .regex(EVENT_TYPE_PATTERN, 'Must be 3-64 characters of a-z, 0-9, "_", "." or "-"')
  .describe('Event type, e.g. order.created');

const eventTypes = z
  .array(eventType)
  .max(MAX_EVENT_TYPES)
  .refine((items) => new Set(items).size === items.length, 'Must not contain duplicates')
  .describe('Subscribed event types; an empty list subscribes to all events');

const endpointUrl = z
  .url({ protocol: /^https?$/, error: 'Must be a valid http(s) URL' })
  .max(2048)
  .describe('Destination URL (http or https)');

const description = z.string().trim().max(500).describe('Free-form description');

export const createEndpointBody = z.strictObject({
  url: endpointUrl,
  description: description.nullish(),
  eventTypes: eventTypes.default([]),
});

export const updateEndpointBody = z
  .strictObject({
    url: endpointUrl.optional(),
    description: description.nullable().optional(),
    eventTypes: eventTypes.optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'At least one field must be provided',
  });

export const endpointSchema = z
  .object({
    id: z.uuid(),
    url: z.string(),
    description: z.string().nullable(),
    eventTypes: z.array(z.string()),
    active: z.boolean(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'Endpoint' });

export const endpointWithSecretSchema = endpointSchema
  .extend({
    secret: z.string().describe('Signing secret; returned only on creation and rotation'),
  })
  .meta({ id: 'EndpointWithSecret' });

export const deliveryStatsSchema = z
  .object({
    PENDING: z.number().int(),
    SUCCEEDED: z.number().int(),
    FAILED: z.number().int(),
    DEAD: z.number().int(),
    total: z.number().int(),
  })
  .meta({ id: 'DeliveryStats' });

export const endpointDetailsSchema = endpointSchema
  .extend({ stats: deliveryStatsSchema })
  .meta({ id: 'EndpointDetails' });

export const endpointPageSchema = paginated(endpointSchema).meta({ id: 'EndpointPage' });

export type CreateEndpointInput = z.infer<typeof createEndpointBody>;
export type UpdateEndpointInput = z.infer<typeof updateEndpointBody>;
export type DeliveryStats = z.infer<typeof deliveryStatsSchema>;
