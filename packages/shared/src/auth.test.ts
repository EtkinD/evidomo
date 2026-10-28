import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  authUserResponseSchema,
  loginRequestSchema,
  registerRequestSchema,
} from './auth.ts';
import { apiErrorSchema } from './api-error.ts';

describe('registerRequestSchema', () => {
  it('normalizes the email by trimming and lower-casing', () => {
    const parsed = registerRequestSchema.parse({
      email: '  Agent@Example.TEST ',
      password: 'a'.repeat(PASSWORD_MIN_LENGTH),
    });

    expect(parsed.email).toBe('agent@example.test');
  });

  it('enforces the password length bounds', () => {
    const email = 'agent@example.test';
    expect(
      registerRequestSchema.safeParse({ email, password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) })
        .success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({ email, password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({ email, password: 'a'.repeat(PASSWORD_MAX_LENGTH) }).success,
    ).toBe(true);
  });

  it('rejects an invalid email', () => {
    const result = registerRequestSchema.safeParse({
      email: 'not-an-email',
      password: 'a'.repeat(PASSWORD_MIN_LENGTH),
    });

    expect(result.success).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('accepts a short password so the policy can change without lockouts', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@example.test', password: 'x' }).success).toBe(
      true,
    );
  });

  it('rejects an empty or oversized password', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@example.test', password: '' }).success).toBe(
      false,
    );
    expect(
      loginRequestSchema.safeParse({
        email: 'a@example.test',
        password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('response schemas', () => {
  it('parses an auth user response', () => {
    const body = {
      user: { id: '7d0b6c1e-6f0a-4a43-9a64-1f2b9c3d4e5f', email: 'agent@example.test' },
    };

    expect(authUserResponseSchema.parse(body)).toEqual(body);
  });

  it('parses an error body and rejects unknown codes', () => {
    expect(apiErrorSchema.parse({ error: 'invalid_credentials' })).toEqual({
      error: 'invalid_credentials',
    });
    expect(apiErrorSchema.safeParse({ error: 'nope' }).success).toBe(false);
  });
});
