import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRICE_TABLE, stepModelIds } from '@evidomo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEFINITIONS_DIR,
  DefinitionError,
  DefinitionNotFoundError,
  loadDefinitions,
  parseMarketProfile,
  parseServiceDefinition,
  type DefinitionIssue,
} from './loader.ts';

const INVALID_DIR = fileURLToPath(new URL('./__tests__/invalid/', import.meta.url));

async function readInvalid(name: string): Promise<string> {
  return readFile(path.join(INVALID_DIR, name), 'utf8');
}

function issuesOf(result: { ok: true } | { ok: false; issues: readonly DefinitionIssue[] }) {
  if (result.ok) throw new Error('Expected the definition to be rejected');
  return result.issues;
}

describe('the repository definitions', () => {
  it('load and validate: listing-launch v1, international v1, nl v1', async () => {
    const registry = await loadDefinitions();

    expect(registry.dir).toBe(path.resolve(DEFAULT_DEFINITIONS_DIR));
    expect(registry.services.map((s) => `${s.id}@${s.version}`)).toEqual(['listing-launch@1']);
    expect(registry.markets.map((m) => `${m.id}@${m.version}`)).toEqual([
      'international@1',
      'nl@1',
    ]);
  });

  it('give the service an exact-decimal budget, efforts on every language-model step, and priced models', async () => {
    const service = (await loadDefinitions()).getService('listing-launch', 1);

    expect(service.budget.max_cost_usd_per_run).toBe('1.00');
    // v1 stages by furnishing empty rooms only; decluttering redraws hidden surfaces (P3-04).
    const staging = service.steps.find((step) => step.agent === 'stager');
    expect(staging?.agent === 'stager' ? staging.operation_kinds : undefined).toEqual(['furnish']);
    expect(service.steps.map((step) => step.id)).toEqual([
      'intake',
      'fact_extraction',
      'vision_inventory',
      'reconciliation',
      'creative',
      'qa_cards',
      'staging',
      'integrity',
      'verification',
      'export',
    ]);
    for (const step of service.steps) {
      for (const { modelId } of stepModelIds(step)) expect(PRICE_TABLE).toHaveProperty([modelId]);
    }
    const reconciliation = service.steps.find((step) => step.id === 'reconciliation');
    expect(reconciliation).toMatchObject({
      model: 'muse-wonder-1.0',
      reasoning_effort: 'low',
      fallback_model: 'muse-spark-1.3',
      fallback_reasoning_effort: 'medium',
      max_output_tokens: 12000,
      gate_after: 'fact_conflicts',
    });
  });

  it('make the NL energy label and NEN 2580 living area the required core', async () => {
    const nl = (await loadDefinitions()).getMarket('nl', 1);

    expect(nl.facts.filter((fact) => fact.required).map((fact) => fact.key)).toEqual([
      'energy_label',
      'living_area',
    ]);
    expect(nl.facts.find((fact) => fact.key === 'living_area')).toMatchObject({
      type: 'area',
      basis: 'NEN2580',
    });
    expect(nl.publication_checklist.map((item) => item.id)).toEqual([
      'energy_label_shown',
      'staging_disclosed',
    ]);
  });

  it('are frozen and looked up by ID and version', async () => {
    const registry = await loadDefinitions();
    const service = registry.getService('listing-launch', 1);

    expect(Object.isFrozen(service.steps[0])).toBe(true);
    expect(() => registry.getService('listing-launch', 2)).toThrow(DefinitionNotFoundError);
    expect(() => registry.getMarket('de', 1)).toThrow('No market definition "de" version 1');
  });
});

describe('invalid definition files', () => {
  it('reject an unknown key, located at the key', async () => {
    const source = await readInvalid('service-unknown-key.yaml');
    expect(issuesOf(parseServiceDefinition(source, 'services/x.yaml'))).toEqual([
      // The misspelled key also leaves the real one missing; both are reported.
      {
        file: 'services/x.yaml',
        line: 9,
        column: 7,
        path: 'service.steps[0].reasoning_effort',
        message:
          'Missing required key "reasoning_effort" (Invalid option: expected one of "minimal"|"low"|"medium"|"high"|"xhigh"|"max")',
      },
      {
        file: 'services/x.yaml',
        line: 12,
        column: 7,
        path: 'service.steps[0]',
        message: 'Unrecognized key: "reasoning_efort"',
      },
    ]);
  });

  it('reject a reasoning effort Meta does not accept', async () => {
    const source = await readInvalid('service-bad-effort.yaml');
    expect(issuesOf(parseServiceDefinition(source, 'services/x.yaml'))).toEqual([
      {
        file: 'services/x.yaml',
        line: 12,
        column: 25,
        path: 'service.steps[0].reasoning_effort',
        message: 'Invalid option: expected one of "minimal"|"low"|"medium"|"high"|"xhigh"|"max"',
      },
    ]);
  });

  it('reject a model without a price, so it fails at boot instead of at the first call', async () => {
    const source = await readInvalid('service-unpriced-model.yaml');
    expect(issuesOf(parseServiceDefinition(source, 'services/x.yaml'))).toEqual([
      {
        file: 'services/x.yaml',
        line: 11,
        column: 14,
        path: 'service.steps[0].model',
        message:
          'Model "muse-spark-9.9" has no entry in the shared price table (PRICE_TABLE), so its calls could not be metered',
      },
    ]);
  });

  it('reject a duplicate step ID', async () => {
    const source = await readInvalid('service-duplicate-step-id.yaml');
    expect(issuesOf(parseServiceDefinition(source, 'services/x.yaml'))).toEqual([
      {
        file: 'services/x.yaml',
        line: 14,
        column: 11,
        path: 'service.steps[1].id',
        message: 'Duplicate step ID "fact_extraction"',
      },
    ]);
  });

  it('reject an area fact whose basis is not in area_bases', async () => {
    const source = await readInvalid('market-area-basis-unknown.yaml');
    expect(issuesOf(parseMarketProfile(source, 'markets/x.yaml'))).toEqual([
      {
        file: 'markets/x.yaml',
        line: 13,
        column: 66,
        path: 'market.facts[0].basis',
        message: 'Area basis "NEN2580" is not listed in area_bases',
      },
    ]);
  });

  it('reject a translation in an unknown language or of the wrong type, located at the key', async () => {
    const source = await readInvalid('market-label-unknown-locale.yaml');
    expect(issuesOf(parseMarketProfile(source, 'markets/x.yaml'))).toEqual([
      {
        file: 'markets/x.yaml',
        line: 18,
        column: 13,
        path: 'market.facts[0].labels.nl',
        message: 'Invalid input: expected string, received number',
      },
      {
        file: 'markets/x.yaml',
        line: 17,
        column: 9,
        path: 'market.facts[0].labels',
        message: 'Unrecognized key: "de"',
      },
    ]);
  });

  it('reject a publication checklist rule the evaluator does not implement, at boot', async () => {
    const nl = await readFile(path.join(DEFAULT_DEFINITIONS_DIR, 'markets/nl.v1.yaml'), 'utf8');
    const source = nl.replace('rule: staged_images_labeled', 'rule: photos_watermarked');
    expect(source).not.toBe(nl);
    const [issue, ...others] = issuesOf(parseMarketProfile(source, 'markets/nl.v1.yaml'));
    expect(others).toEqual([]);
    expect(issue).toMatchObject({
      file: 'markets/nl.v1.yaml',
      path: 'market.publication_checklist[1].rule',
    });
    expect(issue?.message).toMatch(/fact_present.*staged_images_labeled.*no_flagged_phrasing/);
  });

  it('reject malformed YAML', async () => {
    const source = await readInvalid('market-malformed.yaml');
    const issues = issuesOf(parseMarketProfile(source, 'markets/x.yaml'));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.file).toBe('markets/x.yaml');
    expect(issues[0]?.line).toBeGreaterThan(0);
    expect(issues[0]?.message).toMatch(/^Invalid YAML \([A-Z_]+\): /);
  });

  it('reject a duplicate YAML key instead of keeping the last value', async () => {
    const source = await readInvalid('market-duplicate-key.yaml');
    expect(issuesOf(parseMarketProfile(source, 'markets/x.yaml'))).toEqual([
      {
        file: 'markets/x.yaml',
        line: 16,
        column: 3,
        message: 'Invalid YAML (DUPLICATE_KEY): Map keys must be unique',
      },
    ]);
  });

  it('reject unknown tags and aliases', () => {
    const tagged = 'market: !profile\n  id: nl\n';
    expect(issuesOf(parseMarketProfile(tagged, 'markets/x.yaml'))[0]?.message).toMatch(
      /^Invalid YAML \(TAG_RESOLVE_FAILED\): Unresolved tag: !profile/,
    );

    const aliased = 'market:\n  source_languages: &langs [en]\n  output_languages: *langs\n';
    expect(issuesOf(parseMarketProfile(aliased, 'markets/x.yaml'))).toEqual([
      {
        file: 'markets/x.yaml',
        line: 3,
        column: 21,
        message: 'YAML aliases (*name) are not allowed in definitions',
      },
    ]);
  });
});

describe('loadDefinitions on a directory', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function copyOfRepositoryDefinitions(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'evidomo-definitions-'));
    dirs.push(dir);
    await cp(DEFAULT_DEFINITIONS_DIR, dir, { recursive: true });
    return dir;
  }

  async function loadError(dir: string): Promise<DefinitionError> {
    const error: unknown = await loadDefinitions(dir).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (!(error instanceof DefinitionError)) throw new Error('Expected a DefinitionError');
    return error;
  }

  it('reports every broken file with file, line, path, and problem in one error', async () => {
    const dir = await copyOfRepositoryDefinitions();
    await cp(
      path.join(INVALID_DIR, 'service-bad-effort.yaml'),
      path.join(dir, 'services/broken.v1.yaml'),
    );
    await cp(
      path.join(INVALID_DIR, 'market-duplicate-key.yaml'),
      path.join(dir, 'markets/broken.v1.yaml'),
    );

    const error = await loadError(dir);
    expect(error.issues.map((issue) => issue.file)).toEqual([
      'services/broken.v1.yaml',
      'markets/broken.v1.yaml',
    ]);
    expect(error.message).toContain(`Invalid definitions in ${dir} (2 problems):`);
    expect(error.message).toContain(
      'services/broken.v1.yaml:12:25: service.steps[0].reasoning_effort: Invalid option',
    );
    expect(error.message).toContain('markets/broken.v1.yaml:16:3: Invalid YAML (DUPLICATE_KEY)');
  });

  it('requires the file name to match the ID and version', async () => {
    const dir = await copyOfRepositoryDefinitions();
    const source = await readFile(path.join(dir, 'markets/nl.v1.yaml'), 'utf8');
    await writeFile(path.join(dir, 'markets/nl.v2.yaml'), source);

    const error = await loadError(dir);
    expect(error.issues).toEqual([
      {
        file: 'markets/nl.v2.yaml',
        path: 'market.id',
        message: 'File name must match the market ID and version: expected "nl.v1.yaml"',
      },
    ]);
  });

  it('refuses misnamed files instead of skipping them', async () => {
    const dir = await copyOfRepositoryDefinitions();
    await writeFile(path.join(dir, 'markets/de.v1.yml'), 'market: {}\n');

    const error = await loadError(dir);
    expect(error.issues).toEqual([
      { file: 'markets/de.v1.yml', message: 'Expected a file named <id>.v<version>.yaml' },
    ]);
  });

  it('fails on a missing directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evidomo-definitions-'));
    dirs.push(dir);

    const error = await loadError(dir);
    expect(error.issues.map((issue) => issue.file)).toEqual(['services', 'markets']);
    expect(error.issues[0]?.message).toMatch(/^Cannot read directory: ENOENT/);
  });
});
