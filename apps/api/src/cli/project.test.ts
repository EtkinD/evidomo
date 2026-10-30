import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServiceDefinition } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { META_FIXTURES_DIR } from '../meta/fixtures.ts';
import { loadProject, ProjectDirError, projectFileSchema } from './project.ts';

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
    const project = await loadProject(DEMO_PROJECT, definitions, (id, version) =>
      definitions.getService(id, version),
    );
    // The real definition, Q&A step included (the temporary P3-10 filter is gone).
    expect(project.service.steps.map((s) => s.id)).toContain('qa_cards');
    expect(project.market.id).toBe('nl');
    expect(project.outputLanguage).toBe('en');
    expect(project.photos).toHaveLength(11);
    expect(project.voiceMemoPath).toMatch(/voice-memo-standin\.wav$/);
    expect(project.fixture).toBe('p3-10/synthetic-walkthrough');
    expect(project.fixturesDir).toBe(META_FIXTURES_DIR);
  });

  it('resolves fixtureDir against the project directory, so a cassette can live outside the repo', async () => {
    const spec = projectFileSchema.parse(
      JSON.parse(await readFile(path.join(DEMO_PROJECT, 'project.json'), 'utf8')),
    );
    const dir = await mkdtemp(path.join(scratch, 'external-'));
    const photos = spec.photos.map((photo) =>
      path.relative(dir, path.resolve(DEMO_PROJECT, photo)),
    );
    await writeFile(
      path.join(dir, 'project.json'),
      JSON.stringify({
        ...spec,
        photos,
        voiceMemo: path.relative(dir, path.join(DEMO_PROJECT, 'voice-memo-standin.wav')),
        fixtureDir: '../recordings',
        fixture: 'run',
      }),
    );
    await writeFile(path.join(dir, 'decisions.json'), JSON.stringify(validDecisions));
    const project = await loadProject(dir, definitions, getService);
    expect(project.fixturesDir).toBe(path.resolve(dir, '../recordings'));
    expect(project.fixture).toBe('run');

    const absolute = await writeProject({ ...spec, photos, fixtureDir: '/abs' }, validDecisions);
    await expect(loadProject(absolute, definitions, getService)).rejects.toThrow(
      /fixtureDir: must be relative to the project directory/,
    );
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
