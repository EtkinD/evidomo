import pg from 'pg';
import type { Gate, RunStatus } from '@evidomo/shared';

/** Base class for expected, typed repository failures (mapped to HTTP errors by callers). */
export class RepositoryError extends Error {
  override name = 'RepositoryError';
}

export class NotFoundError extends RepositoryError {
  override name = 'NotFoundError';
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.entity = entity;
    this.id = id;
  }
}

export class EmailTakenError extends RepositoryError {
  override name = 'EmailTakenError';

  constructor() {
    // The address itself is personal data and stays out of the message.
    super('A user with this email already exists');
  }
}

export class InvalidRunTransitionError extends RepositoryError {
  override name = 'InvalidRunTransitionError';
  readonly runId: string;
  readonly from: RunStatus;
  readonly to: RunStatus;

  constructor(runId: string, from: RunStatus, to: RunStatus) {
    super(`Run ${runId} cannot move from ${from} to ${to}`);
    this.runId = runId;
    this.from = from;
    this.to = to;
  }
}

export class GateNotOpenError extends RepositoryError {
  override name = 'GateNotOpenError';
  readonly runId: string;
  readonly gate: Gate;

  constructor(runId: string, gate: Gate) {
    super(`Run ${runId} is not awaiting gate ${gate}`);
    this.runId = runId;
    this.gate = gate;
  }
}

export class DecisionAlreadyRecordedError extends RepositoryError {
  override name = 'DecisionAlreadyRecordedError';
  readonly runId: string;
  readonly targetId: string;

  constructor(runId: string, targetId: string) {
    super(`A decision for ${targetId} is already recorded on run ${runId}`);
    this.runId = runId;
    this.targetId = targetId;
  }
}

/** Finds the PostgreSQL error behind a (possibly Drizzle-wrapped) query failure. */
export function findPgError(error: unknown): pg.DatabaseError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof pg.DatabaseError) return current;
    current = current.cause;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = findPgError(error);
  return pgError?.code === '23505' && pgError.constraint === constraint;
}

export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  const pgError = findPgError(error);
  return pgError?.code === '23503' && pgError.constraint === constraint;
}
