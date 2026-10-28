import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 12;
// Bounds the argon2 input so a request cannot buy arbitrary hashing work.
export const PASSWORD_MAX_LENGTH = 256;
export const EMAIL_MAX_LENGTH = 254;

/** Trimmed and lower-cased before validation, matching how the API stores emails. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(EMAIL_MAX_LENGTH));

export const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: newPasswordSchema,
});

export type RegisterRequest = z.input<typeof registerRequestSchema>;

// Login does not re-apply the length policy: a too-short password simply fails verification,
// and the policy may change without locking out existing accounts.
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export type LoginRequest = z.input<typeof loginRequestSchema>;

export const authUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
});

export type AuthUser = z.infer<typeof authUserSchema>;

/** Body of a successful register (201), login (200), and `GET /api/auth/me` (200). */
export const authUserResponseSchema = z.object({
  user: authUserSchema,
});

export type AuthUserResponse = z.infer<typeof authUserResponseSchema>;
