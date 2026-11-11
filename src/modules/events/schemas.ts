import { z } from 'zod';
import { dateTime, paginated, paginationQuery } from '../../lib/schemas.js';
import { deliverySchema } from '../deliveries/schemas.js';
import { eventType } from '../endpoints/schemas.js';

export const MAX_PAYLOAD_BYTES = 64 * 1024;

const payload = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_PAYLOAD_BYTES,
    `Serialized payload must not exceed ${MAX_PAYLOAD_BYTES} bytes`,
  )
  .describe('Arbitrary JSON object delivered to subscribers');

export const publishEventBody = z.strictObject({
  type: eventType,
  payload,
});

export const eventSchema = z
  .object({
    id: z.uuid(),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: dateTime,
  })
  .meta({ id: 'Event' });

export const publishedEventSchema = z
  .object({
    event: eventSchema,
    deliveries: z.number().int().describe('Number of deliveries created for subscribed endpoints'),
  })
  .meta({ id: 'PublishedEvent' });

export const eventDetailsSchema = eventSchema
  .extend({ deliveries: z.array(deliverySchema) })
  .meta({ id: 'EventDetails' });

export const eventPageSchema = paginated(eventSchema).meta({ id: 'EventPage' });

export const eventsQuery = paginationQuery.extend({
  type: eventType.optional(),
});

export type PublishEventInput = z.infer<typeof publishEventBody>;
export type EventsQuery = z.infer<typeof eventsQuery>;
