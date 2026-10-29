import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServiceDefinition } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { cliServiceRegistry, DEFERRED_STEP_ID, withoutDeferredSteps } from './definition.ts';
import { loadProject, ProjectDirError } from './project.ts';

const DEMO_PROJECT = path.resolve(
  import.meta.dirname,
  '../../../../fixtures/projects/synthetic-walkthrough',
);

let definitions: DefinitionRegistry;
let scratch: string;
const getService = (id: string, version: number): ServiceDefinition =>
  definitions.getService(id, version);

beforeAll(async () => {
  definitions = await loadDefinitions();
  scratch = await mkdtemp(path.join(tmpdir(), 'evidomo-cli-project-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writeProject(project: unknown, decisions: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(scratch, 'p-'));
  await writeFile(path.join(dir, 'project.json'), JSON.stringify(project));
  await writeFile(path.join(dir, 'decisions.json'), JSON.stringify(decisions));
  return dir;
}

const validDecisions = {
  formatVersion: 1,
  factConflicts: { default: 'reject' },
  claimAudit: { claims: { default: 'remove' }, images: { default: 'accept' } },
};

describe('loadProject', () => {
  it('loads the committed demo project against the real definitions', async () => {
    const registry = cliServiceRegistry(definitions);
    const project = await loadProject(DEMO_PROJECT, definitions, (id, version) =>
      registry.getService(id, version),
    );
    expect(project.service.steps.map((s) => s.id)).not.toContain(DEFERRED_STEP_ID);
    expect(project.market.id).toBe('nl');
    expect(project.outputLanguage).toBe('en');
    expect(project.photos).toHaveLength(11);
    expect(project.voiceMemoPath).toMatch(/voice-memo-standin\.wav$/);
    expect(project.fixture).toBe('p3-10/synthetic-walkthrough');
  });

  it('reports every problem at once, naming files and fields', async () => {
    const dir = await writeProject(
      {
        formatVersion: 1,
        title: 'Invalid',
        service: { id: 'listing-launch', version: 1 },
        market: { id: 'nl', version: 1 },
        outputLanguage: 'fr',
        officeProfile: { agencyName: 'Demo' },
        factForm: { living_area: 'large' },
        photos: ['a.jpg', 'sub/a.jpg'],
        voiceMemo: null,
        fixture: null,
      },
      {
        ...validDecisions,
        claimAudit: {
          claims: { default: 'remove' },
          images: { default: 'accept', decisions: [{ photo: 'other.jpg', choice: 'reject' }] },
        },
      },
    );
    const error = await loadProject(dir, definitions, getService).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectDirError);
    const problems = error instanceof ProjectDirError ? error.problems : [];
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('outputLanguage: "fr" is not offered by market nl'),
        expect.stringContaining('missing required field(s): energy_label'),
        expect.stringContaining('invalid value for field(s): living_area'),
        expect.stringContaining('takes 10–30 photos'),
        expect.stringContaining('requires a voice walkthrough'),
        expect.stringContaining('file name "a.jpg" is used twice'),
        expect.stringContaining('input file not found'),
        expect.stringContaining('"other.jpg" is not a project photo'),
      ]),
    );
  });

  it('reports schema problems in both files and a missing decisions file', async () => {
    const dir = await writeProject({ formatVersion: 2 }, { formatVersion: 1 });
    await expect(loadProject(dir, definitions, getService)).rejects.toThrow(
      /project\.json: formatVersion[\s\S]*decisions\.json: factConflicts/,
    );
    await rm(path.join(dir, 'decisions.json'));
    await expect(loadProject(dir, definitions, getService)).rejects.toThrow(
      /decisions\.json: file is missing/,
    );
  });
});

describe('withoutDeferredSteps (temporary, until cut level 1 is decided)', () => {
  it('drops qa_cards and nothing else, and is a no-op without it', () => {
    const service = definitions.getService('listing-launch', 1);
    const filtered = withoutDeferredSteps(service);
    expect(filtered.steps.map((s) => s.id)).toEqual(
      service.steps.map((s) => s.id).filter((id) => id !== DEFERRED_STEP_ID),
    );
    expect(filtered.id).toBe(service.id);
    expect(withoutDeferredSteps(filtered)).toBe(filtered);
  });
});
