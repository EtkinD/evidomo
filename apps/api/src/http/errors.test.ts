import { DrizzleQueryError } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { errorForLog } from './errors.ts';

function uniqueViolation(): pg.DatabaseError {
  const error = new pg.DatabaseError(
    'duplicate key value violates unique constraint "users_email_lower_key"',
    0,
    'error',
  );
  error.code = '23505';
  error.constraint = 'users_email_lower_key';
  error.table = 'users';
  error.detail = 'Key (lower(email))=(agent@example.test) already exists.';
  return error;
}

describe('errorForLog', () => {
  it('drops bound parameters and row values from database errors', () => {
    const error = new DrizzleQueryError(
      'insert into "users" ("email", "password_hash") values ($1, $2)',
      ['agent@example.test', '$argon2id$v=19$m=19456,t=2,p=1$salt$hash'],
      uniqueViolation(),
    );

    const logged = JSON.stringify(errorForLog(error));

    expect(logged).not.toContain('agent@example.test');
    expect(logged).not.toContain('$argon2id$');
    expect(errorForLog(error)).toMatchObject({
      query: 'insert into "users" ("email", "password_hash") values ($1, $2)',
      pg: { code: '23505', constraint: 'users_email_lower_key', table: 'users' },
    });
  });

  it('drops the detail of a bare PostgreSQL error', () => {
    expect(JSON.stringify(errorForLog(uniqueViolation()))).not.toContain('agent@example.test');
  });

  it('passes other errors through for the standard serializer', () => {
    const error = new Error('boom');

    expect(errorForLog(error)).toBe(error);
  });
});
