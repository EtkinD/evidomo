import { z } from 'zod';

export const healthStatusSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    database: z.enum(['ok', 'unavailable']),
  }),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
