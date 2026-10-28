import { DrizzleQueryError } from 'drizzle-orm';
import type { ErrorRequestHandler, Response } from 'express';
import type { ApiError, ApiValidationIssue } from '@evidomo/shared';
import type { z } from 'zod';
import { findPgError } from '../db/errors.ts';
import type { Logger } from '../logger.ts';

export function sendError(res: Response, status: number, error: ApiError['error']): void {
  res.status(status).json({ error } satisfies ApiError);
}

export function sendValidationError(res: Response, error: z.ZodError): void {
  const issues: ApiValidationIssue[] = error.issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === 'number' ? key : String(key))),
    message: issue.message,
  }));
  res.status(400).json({ error: 'validation_failed', issues } satisfies ApiError);
}

/**
 * A log-safe view of an error. Drizzle puts every bound parameter (emails, password hashes,
 * user content) into `DrizzleQueryError`'s message, stack, and `params`; PostgreSQL puts row
 * values into `detail`. Both are reduced to the SQL text and the PostgreSQL error code.
 */
export function errorForLog(error: unknown): unknown {
  const pgError = findPgError(error);
  if (error instanceof DrizzleQueryError || pgError !== undefined) {
    return {
      type: error instanceof Error ? error.name : typeof error,
      query: error instanceof DrizzleQueryError ? error.query : undefined,
      pg:
        pgError === undefined
          ? undefined
          : {
              code: pgError.code,
              message: pgError.message,
              constraint: pgError.constraint,
              table: pgError.table,
              column: pgError.column,
              routine: pgError.routine,
            },
    };
  }
  return error;
}

interface BodyParserError {
  type: string;
  status: number;
}

// body-parser (used by express.json) rejects with an http-errors object carrying a `type`.
function asBodyParserError(error: unknown): BodyParserError | undefined {
  if (
    error instanceof Error &&
    'type' in error &&
    typeof error.type === 'string' &&
    'status' in error &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return { type: error.type, status: error.status };
  }
  return undefined;
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      // Express's default handler closes the connection; there is nothing left to answer.
      next(error);
      return;
    }

    const bodyError = asBodyParserError(error);
    if (bodyError !== undefined) {
      // Never log the error object: body-parser attaches the raw body (it may hold a password)
      // as `body`, and recent V8 parse messages quote part of the input.
      logger.warn({ type: bodyError.type }, 'rejected request body');
      if (bodyError.type === 'entity.too.large') {
        sendError(res, 413, 'payload_too_large');
      } else if (
        bodyError.type === 'charset.unsupported' ||
        bodyError.type === 'encoding.unsupported'
      ) {
        sendError(res, 415, 'unsupported_media_type');
      } else {
        sendError(res, 400, 'invalid_json');
      }
      return;
    }

    logger.error({ err: errorForLog(error) }, 'unhandled request error');
    sendError(res, 500, 'internal_error');
  };
}
