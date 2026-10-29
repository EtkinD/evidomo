import { demoRunSchema, type DemoRun } from '@evidomo/shared';
import { and, eq, getTableColumns } from 'drizzle-orm';
import type { Executor } from '../db/client.ts';
import type { Run } from '../db/repositories/runs.ts';
import { projects, runs, users } from '../db/schema.ts';
import { DEMO_OWNER_EMAIL } from './owner.ts';

// Which runs the public demo API serves (docs/architecture.md §11): the IDs in `DEMO_RUN_IDS`,
// and of those only runs that exist, completed, and belong to a project of the demo owner
// (`DEMO_OWNER_EMAIL`, created by `npm run demo:seed`). The owner check is defense in depth: a
// real customer's run listed by mistake still answers 404. Anything else is 404, exactly like an unknown
// ID, so the demo never confirms that a run exists. Whatever is listed becomes public without
// login: only synthetic runs (`npm run demo:seed`) belong in the list.

export interface DemoRunsDeps {
  readonly db: Executor;
  /** `DEMO_RUN_IDS`, lower-cased by the env schema. */
  readonly runIds: readonly string[];
}

export interface DemoRuns {
  /**
   * The demo run with this ID, or undefined when it is not listed, missing, not completed, or
   * not owned by the demo owner.
   */
  resolve(runId: string): Promise<Run | undefined>;
  /** Every listed run that exists and completed, in `DEMO_RUN_IDS` order. */
  list(): Promise<DemoRun[]>;
}

export function createDemoRuns({ db, runIds }: DemoRunsDeps): DemoRuns {
  const allowed = new Set(runIds.map((id) => id.toLowerCase()));

  /** The listed, completed run of a demo-owned project, with its title (one indexed join). */
  async function load(runId: string): Promise<{ run: Run; title: string } | undefined> {
    const id = runId.toLowerCase();
    if (!allowed.has(id)) return undefined;
    const [row] = await db
      .select({ run: getTableColumns(runs), title: projects.title })
      .from(runs)
      .innerJoin(projects, eq(projects.id, runs.projectId))
      .innerJoin(users, eq(users.id, projects.ownerId))
      .where(and(eq(runs.id, id), eq(users.email, DEMO_OWNER_EMAIL)));
    // Only a completed run is replayable as a whole flow, and a completed run never changes.
    return row?.run.status === 'completed' ? row : undefined;
  }

  return {
    resolve: async (runId) => (await load(runId))?.run,
    async list() {
      const listed: DemoRun[] = [];
      for (const id of allowed) {
        const found = await load(id);
        if (found === undefined) continue;
        const { run, title } = found;
        listed.push(
          demoRunSchema.parse({
            id: run.id,
            title,
            marketProfileId: run.marketProfileId,
            outputLanguage: run.outputLanguage,
            createdAt: run.createdAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
          } satisfies DemoRun),
        );
      }
      return listed;
    },
  };
}
