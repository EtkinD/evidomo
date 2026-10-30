import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownStepIds, stepLabel } from '../lib/step-labels';
import { testTranslator } from './test-utils';

const DEFINITION = resolve(__dirname, '../../../../definitions/services/listing-launch.v1.yaml');

/** Step IDs in order: the `- id:` entries after the `steps:` key (no YAML dependency in the web app). */
function definitionStepIds(): string[] {
  const lines = readFileSync(DEFINITION, 'utf8').split('\n');
  const start = lines.findIndex((line) => /^ {2}steps:\s*$/.test(line));
  expect(start).toBeGreaterThan(-1);
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) || /^ {2}\S/.test(line)) break;
    const match = /^ {4}- id: (\w+)\s*$/.exec(line);
    if (match?.[1] !== undefined) ids.push(match[1]);
  }
  return ids;
}

describe('step labels', () => {
  it('reads the steps of the current service definition', () => {
    expect(definitionStepIds().length).toBeGreaterThanOrEqual(10);
  });

  it('labels every step of the listing-launch definition with a description', () => {
    for (const id of definitionStepIds()) {
      const { label, description } = stepLabel(testTranslator('steps'), id);
      expect(knownStepIds(), id).toContain(id);
      expect(label, id).not.toBe('');
      expect(description, id).not.toBe('');
      // A label in plain words, not the raw identifier.
      expect(label, id).not.toMatch(/_/);
    }
  });

  it('keeps no label for a step the definition no longer has', () => {
    expect(knownStepIds().sort()).toEqual(definitionStepIds().sort());
  });

  it('humanises an unknown step ID', () => {
    expect(stepLabel(testTranslator('steps'), 'photo_check')).toEqual({
      label: 'Photo check',
      description: '',
    });
    expect(stepLabel(testTranslator('steps'), 'x-y')).toEqual({ label: 'X y', description: '' });
  });
});
