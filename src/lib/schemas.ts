import { z } from 'zod';

export const MAX_PAGE = 100_000;
export const MAX_LIMIT = 100;

export const dateTime = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString(),
});

export const idParams = z.object({
  id: z.uuid().describe('Resource id'),
});

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1).describe('Page number, from 1'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(20)
    .describe(`Page size, up to ${MAX_LIMIT}`),
});

export type Pagination = z.infer<typeof paginationQuery>;

export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  });

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export const errorResponse = z
  .object({
    statusCode: z.number().int(),
    error: z.string(),
    message: z.union([z.string(), z.array(z.string())]),
    path: z.string(),
    timestamp: z.iso.datetime(),
  })
  .meta({ id: 'ErrorResponse', description: 'Error payload shared by all endpoints' });

export const errorResponses = {
  400: errorResponse,
  404: errorResponse,
  409: errorResponse,
  500: errorResponse,
} as const;

export const pickErrors = <K extends keyof typeof errorResponses>(...codes: K[]) =>
  Object.fromEntries(codes.map((code) => [code, errorResponses[code]])) as Pick<
    typeof errorResponses,
    K
  >;

export const offsetOf = ({ page, limit }: Pagination) => (page - 1) * limit;
