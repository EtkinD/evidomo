import { sql } from 'drizzle-orm';
import { text } from 'node:stream/consumers';
import { z } from 'zod';
import type { Executor } from '../db/client.ts';
import { listExistingProjectIds } from '../db/repositories/projects.ts';
import type { Logger } from '../logger.ts';
import {
  isProjectStorageSegment,
  PROJECTS_STORAGE_PREFIX,
  projectStoragePrefix,
  StorageNotFoundError,
  type Storage,
} from '../storage/storage.ts';

// Orphaned project files (docs/architecture.md §8 "Project deletion"). Every file of a project
// lives below `projects/<projectId>/`, so a directory there whose project row no longer exists
// holds orphans: files whose deletion failed after the project was deleted, or files a
// straggling writer (a detached step execution) stored after it. A project deletion removes only
// its own prefix; this sweep is the operator's tool (`npm run storage:sweep`).
//
// Two guards keep it from deleting files that are still wanted:
// - The storage records the database it belongs to (`system/database-binding.json`) and the sweep
//   deletes only when that record names the connected database: a development API pointed at
//   another database but the default STORAGE_DIR would otherwise see every real project as an
//   orphan. Only the operator writes the record (`--bind`).
// - A minimum age: a directory with anything modified more recently is skipped, so files of a
//   project whose row is missing for a moment (a point-in-time restore of the database in
//   progress, a deletion being investigated) are not removed at once.

/** Where the storage records the database it belongs to. Not below `projects/`. */
export const STORAGE_BINDING_KEY = 'system/database-binding.json';

/** Default minimum age of an orphaned project directory before the sweep removes it. */
export const DEFAULT_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const EXISTENCE_QUERY_CHUNK = 1000;

const databaseIdentitySchema = z.strictObject({
  database: z.string().min(1),
  /** `pg_database.oid`: a database dropped and created again under the same name differs. */
  databaseOid: z.string().regex(/^\d+$/),
});
export type DatabaseIdentity = z.infer<typeof databaseIdentitySchema>;

export async function databaseIdentity(db: Executor): Promise<DatabaseIdentity> {
  const result = await db.execute(
    sql`select current_database() as "database",
      (select oid::text from pg_database where datname = current_database()) as "databaseOid"`,
  );
  return databaseIdentitySchema.parse(result.rows[0]);
}

type BindingState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'bound'; readonly identity: DatabaseIdentity };

async function readBinding(storage: Storage): Promise<BindingState> {
  let raw: string;
  try {
    raw = await text(await storage.get(STORAGE_BINDING_KEY));
  } catch (error) {
    if (error instanceof StorageNotFoundError) return { kind: 'absent' };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Unreadable, not missing: treated like a binding to another database.
    return { kind: 'invalid' };
  }
  const parsed = databaseIdentitySchema.safeParse(json);
  return parsed.success ? { kind: 'bound', identity: parsed.data } : { kind: 'invalid' };
}

async function writeBinding(storage: Storage, identity: DatabaseIdentity): Promise<void> {
  await storage.put(STORAGE_BINDING_KEY, new TextEncoder().encode(`${JSON.stringify(identity)}\n`));
}

function sameDatabase(a: DatabaseIdentity, b: DatabaseIdentity): boolean {
  return a.database === b.database && a.databaseOid === b.databaseOid;
}

export interface OrphanScan {
  /** Project directories whose project does not exist, sorted. */
  readonly orphanProjectIds: readonly string[];
  /** Project directories looked at. */
  readonly scannedCount: number;
  /** Names below `projects/` that are not project IDs: never touched. */
  readonly ignoredCount: number;
}

/** Lists `projects/<id>` directories without a project row. Read-only. */
export async function findOrphanedProjects(db: Executor, storage: Storage): Promise<OrphanScan> {
  const children = await storage.listChildren(PROJECTS_STORAGE_PREFIX);
  const projectIds = children.filter(isProjectStorageSegment);
  const orphans: string[] = [];
  for (let start = 0; start < projectIds.length; start += EXISTENCE_QUERY_CHUNK) {
    const chunk = projectIds.slice(start, start + EXISTENCE_QUERY_CHUNK);
    const existing = await listExistingProjectIds(db, chunk);
    orphans.push(...chunk.filter((id) => !existing.has(id)));
  }
  return {
    orphanProjectIds: orphans,
    scannedCount: projectIds.length,
    ignoredCount: children.length - projectIds.length,
  };
}

export interface SweepOptions {
  /** Orphaned projects removed in this sweep at most; the rest wait for the next one. */
  readonly limit: number;
  /**
   * Record that the storage belongs to the connected database first, replacing any earlier
   * record (the operator checked the pairing: CLI `--bind`). Without it, an unbound storage or
   * one bound elsewhere is refused.
   */
  readonly bind: boolean;
  /** Orphans with anything modified within this many milliseconds are skipped. */
  readonly minAgeMs: number;
  /** List only: nothing is deleted and no binding is written. */
  readonly dryRun?: boolean;
  /** Defaults to the current time. */
  readonly now?: Date;
}

export type SweepResult =
  | {
      readonly status: 'swept';
      readonly scan: OrphanScan;
      readonly removedProjectIds: readonly string[];
      readonly failedProjectIds: readonly string[];
      /** Orphans skipped because something in them is younger than `minAgeMs`. */
      readonly tooRecentProjectIds: readonly string[];
      /** Orphans left for a later sweep because of `limit`. */
      readonly deferredCount: number;
    }
  | { readonly status: 'dry_run'; readonly scan: OrphanScan; readonly binding: BindingVerdict }
  | {
      /** Nothing was deleted: the storage is not (provably) this database's. */
      readonly status: 'refused';
      readonly reason: 'unbound' | 'bound_elsewhere';
      readonly scan: OrphanScan;
    };

export type BindingVerdict = 'bound' | 'unbound' | 'bound_elsewhere';

export interface SweepDeps {
  readonly db: Executor;
  readonly storage: Storage;
  readonly logger: Logger;
}

/**
 * Removes the files of orphaned projects (`findOrphanedProjects`) that are at least `minAgeMs`
 * old, at most `limit` projects per call, after checking that the storage belongs to the
 * connected database. A project whose removal fails is logged with its ID and prefix and left for
 * the next sweep; the sweep itself only throws when the database or the storage listing fails.
 */
export async function sweepOrphanedProjectFiles(
  deps: SweepDeps,
  options: SweepOptions,
): Promise<SweepResult> {
  const { db, storage, logger } = deps;
  const identity = await databaseIdentity(db);
  const binding = await readBinding(storage);
  const scan = await findOrphanedProjects(db, storage);

  const verdict: BindingVerdict =
    binding.kind === 'absent'
      ? 'unbound'
      : binding.kind === 'bound' && sameDatabase(binding.identity, identity)
        ? 'bound'
        : 'bound_elsewhere';
  if (options.dryRun === true) return { status: 'dry_run', scan, binding: verdict };

  if (options.bind) {
    await writeBinding(storage, identity);
    logger.info({ database: identity.database }, 'storage bound to this database');
  } else if (verdict !== 'bound') {
    // Counts only: a stranger's project IDs are none of this log's business.
    logger.warn(
      { reason: verdict, orphanCount: scan.orphanProjectIds.length },
      'orphaned file sweep refused: the storage is not bound to this database',
    );
    return { status: 'refused', reason: verdict, scan };
  }

  const cutoff = (options.now ?? new Date()).getTime() - Math.max(0, options.minAgeMs);
  const removed: string[] = [];
  const failed: string[] = [];
  const tooRecent: string[] = [];
  let deferredCount = 0;
  for (const projectId of scan.orphanProjectIds) {
    if (removed.length + failed.length >= Math.max(0, options.limit)) {
      deferredCount += 1;
      continue;
    }
    const prefix = projectStoragePrefix(projectId);
    try {
      const modified = await storage.lastModified(prefix);
      if (modified !== undefined && modified.getTime() > cutoff) {
        tooRecent.push(projectId);
        continue;
      }
      await storage.deletePrefix(prefix);
      removed.push(projectId);
    } catch (error) {
      failed.push(projectId);
      logger.error({ err: error, projectId, prefix }, 'could not remove orphaned project files');
    }
  }
  logger.info(
    {
      removedCount: removed.length,
      failedCount: failed.length,
      tooRecentCount: tooRecent.length,
      deferredCount,
    },
    'orphaned project files swept',
  );
  return {
    status: 'swept',
    scan,
    removedProjectIds: removed,
    failedProjectIds: failed,
    tooRecentProjectIds: tooRecent,
    deferredCount,
  };
}
