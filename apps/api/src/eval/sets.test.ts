import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '../cli/project.ts';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { cassettePath } from '../meta/fixtures.ts';
import { EvalSetError, loadEvalSet, loadEvalSets, selectEvalSets } from './sets.ts';

let definitions: DefinitionRegistry;
let scratch: string;

beforeAll(async () => {
  definitions = await loadDefinitions();
  scratch = await mkdtemp(path.join(tmpdir(), 'evidomo-eval-sets-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('committed eval sets', () => {
  it('load, run committed projects with recorded cassettes, and plant on real form fields', async () => {
    const sets = await loadEvalSets();
    expect(sets.length).toBeGreaterThanOrEqual(4);
    for (const set of sets) {
      const project = await loadProject(set.projectDir, definitions, (id, version) =>
        definitions.getService(id, version),
      );
      for (const name of [set.cassette, ...set.include]) {
        await access(cassettePath(name));
      }
      for (const conflict of set.conflicts) {
        if ('formField' in conflict.planted) {
          expect(project.factForm, `${set.id} ${conflict.id}`).toHaveProperty(
            conflict.planted.formField,
          );
        }
      }
      // Every set seeds something to measure.
      expect(set.conflicts.length + set.injections.length + set.temptations.length).toBeGreaterThan(
        0,
      );
    }
    const planted = sets.flatMap((s) => s.conflicts.filter((c) => c.origin === 'planted'));
    const injected = sets.flatMap((s) => s.injections);
    expect(planted.length).toBeGreaterThanOrEqual(10);
    expect(new Set(injected.map((i) => i.expect.detector))).toEqual(
      new Set(['validator', 'verifier']),
    );
  });

  it('selects by ID and refuses unknown IDs', async () => {
    const sets = await loadEvalSets();
    const first = sets[0];
    if (first === undefined) throw new Error('no sets');
    expect(selectEvalSets(sets, [first.id]).map((s) => s.id)).toEqual([first.id]);
    expect(selectEvalSets(sets, [])).toHaveLength(sets.length);
    expect(() => selectEvalSets(sets, ['nope'])).toThrow(EvalSetError);
  });
});

describe('loadEvalSet', () => {
  async function writeSet(name: string, content: unknown): Promise<string> {
    const dir = path.join(scratch, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'eval.json'), JSON.stringify(content));
    return dir;
  }

  const valid = {
    formatVersion: 1,
    id: 'one',
    title: 't',
    description: 'd',
    cassette: 'p5-01/one',
    conflicts: [],
  };

  it('requires the ID to be the directory name', async () => {
    await expect(loadEvalSet(await writeSet('other', valid))).rejects.toThrow(/directory name/);
    await expect(loadEvalSet(await writeSet('one', valid))).resolves.toMatchObject({
      id: 'one',
      include: [],
      injections: [],
    });
  });

  it('refuses invalid patterns, duplicate answer-key IDs, and unknown fields', async () => {
    const conflict = {
      id: 'x',
      origin: 'planted',
      description: 'd',
      planted: { source: 'transcript_turn', key: '([' },
      against: ['form'],
      decidedBy: 'model',
    };
    await expect(
      loadEvalSet(await writeSet('one', { ...valid, conflicts: [conflict] })),
    ).rejects.toThrow(/valid regular expression/);
    const ok = { ...conflict, planted: { formField: 'rooms' } };
    await expect(
      loadEvalSet(await writeSet('one', { ...valid, conflicts: [ok, ok] })),
    ).rejects.toThrow(/twice/);
    await expect(loadEvalSet(await writeSet('one', { ...valid, extra: 1 }))).rejects.toThrow(
      EvalSetError,
    );
  });
});
