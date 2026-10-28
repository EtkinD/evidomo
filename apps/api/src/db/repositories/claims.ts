import {
  jsonValueSchema,
  type JsonValue,
  type ValidatorResult,
  type VerifierVerdict,
} from '@evidomo/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { NotFoundError } from '../errors.ts';
import { claims } from '../schema.ts';

type ClaimRow = typeof claims.$inferSelect;

export type Claim = Omit<ClaimRow, 'validatorDetails' | 'verifierDetails'> & {
  validatorDetails: JsonValue | null;
  verifierDetails: JsonValue | null;
};

export interface NewClaim {
  segmentIndex: number;
  text: string;
  /** Fact IDs exactly as cited; unknown or malformed IDs are kept for the audit trail. */
  factIds: readonly string[];
  validatorResult?: ValidatorResult;
  validatorDetails?: JsonValue;
}

function parseJson(value: unknown): JsonValue | null {
  return value === null ? null : jsonValueSchema.parse(value);
}

function toClaim(row: ClaimRow): Claim {
  return {
    ...row,
    validatorDetails: parseJson(row.validatorDetails),
    verifierDetails: parseJson(row.verifierDetails),
  };
}

export async function insertClaims(
  db: Executor,
  artifactId: string,
  newClaims: readonly NewClaim[],
): Promise<Claim[]> {
  if (newClaims.length === 0) return [];
  const rows = await db
    .insert(claims)
    .values(
      newClaims.map((claim) => ({
        artifactId,
        segmentIndex: claim.segmentIndex,
        text: claim.text,
        factIds: [...claim.factIds],
        validatorResult: claim.validatorResult ?? null,
        validatorDetails:
          claim.validatorDetails === undefined
            ? null
            : jsonValueSchema.parse(claim.validatorDetails),
      })),
    )
    .returning();
  return rows.map(toClaim);
}

export async function listClaims(db: Executor, artifactId: string): Promise<Claim[]> {
  const rows = await db
    .select()
    .from(claims)
    .where(eq(claims.artifactId, artifactId))
    .orderBy(asc(claims.segmentIndex));
  return rows.map(toClaim);
}

export async function recordVerifierVerdict(
  db: Executor,
  claimId: string,
  verdict: VerifierVerdict,
  details?: JsonValue,
): Promise<Claim> {
  const rows = await db
    .update(claims)
    .set({
      verifierVerdict: verdict,
      verifierDetails: details === undefined ? null : jsonValueSchema.parse(details),
      updatedAt: sql`now()`,
    })
    .where(eq(claims.id, claimId))
    .returning();
  const [row] = rows;
  if (!row) throw new NotFoundError('claim', claimId);
  return toClaim(row);
}
