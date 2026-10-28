import { describe, expect, it } from 'vitest';
import { healthStatusSchema } from './health.ts';

describe('healthStatusSchema', () => {
  it('accepts a degraded status with an unavailable database', () => {
    const parsed = healthStatusSchema.parse({
      status: 'degraded',
      checks: { database: 'unavailable' },
    });

    expect(parsed.checks.database).toBe('unavailable');
  });

  it('rejects unknown status values', () => {
    const result = healthStatusSchema.safeParse({ status: 'up', checks: { database: 'ok' } });

    expect(result.success).toBe(false);
  });
});
