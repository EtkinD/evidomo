import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDetailResponseSchema } from '@evidomo/shared';

// The pipeline journeys (e2e/pipeline*.spec.ts) run the real product against the replay worker
// of the isolated stack (playwright.config.ts), which answers every model request from the
// cassette of fixtures/projects/synthetic-walkthrough. So the project they make must be that
// project: same market, language, office profile, fact form, photos in order, and voice memo.

const PROJECT_DIR = fileURLToPath(
  new URL('../../fixtures/projects/synthetic-walkthrough/', import.meta.url),
);

type FactValue = string | number | boolean;

interface ProjectFileInputs {
  readonly title: string;
  readonly officeProfile: { agencyName: string; contactBlock: string; tone: string };
  readonly photos: readonly string[];
  readonly voiceMemo: string;
  readonly factForm: Readonly<Record<string, FactValue>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A hand-written check of the few fields used here: the e2e suite has no zod dependency of
// its own, and the API's full project-file schema would pull the pipeline's modules in.
function parseProjectFile(value: unknown): ProjectFileInputs {
  if (!isRecord(value)) throw new Error('project.json is not an object');
  const { title, officeProfile, photos, voiceMemo, factForm } = value;
  if (typeof title !== 'string') throw new Error('project.json: title');
  if (
    !isRecord(officeProfile) ||
    typeof officeProfile['agencyName'] !== 'string' ||
    typeof officeProfile['contactBlock'] !== 'string' ||
    typeof officeProfile['tone'] !== 'string'
  ) {
    throw new Error('project.json: officeProfile');
  }
  if (!Array.isArray(photos) || photos.length !== 11 || !photos.every((p) => typeof p === 'string'))
    throw new Error('project.json: photos (11 file names)');
  if (typeof voiceMemo !== 'string') throw new Error('project.json: voiceMemo');
  if (!isRecord(factForm)) throw new Error('project.json: factForm');
  const facts: Record<string, FactValue> = {};
  for (const [key, fact] of Object.entries(factForm)) {
    if (typeof fact !== 'string' && typeof fact !== 'number' && typeof fact !== 'boolean')
      throw new Error(`project.json: factForm.${key}`);
    facts[key] = fact;
  }
  return {
    title,
    officeProfile: {
      agencyName: officeProfile['agencyName'],
      contactBlock: officeProfile['contactBlock'],
      tone: officeProfile['tone'],
    },
    photos: photos.filter((p): p is string => typeof p === 'string'),
    voiceMemo,
    factForm: facts,
  };
}

/** The synthetic project's inputs, with file paths resolved against its directory. */
function fixtureInput() {
  const file = parseProjectFile(JSON.parse(readFileSync(`${PROJECT_DIR}project.json`, 'utf8')));
  const resolve = (relative: string): string => path.resolve(PROJECT_DIR, relative);
  return {
    title: file.title,
    ...file.officeProfile,
    photos: file.photos.map(resolve),
    voiceMemo: resolve(file.voiceMemo),
    factForm: file.factForm,
  };
}

/**
 * Registers an account, creates the synthetic project through the UI, fills its fact form,
 * uploads its photos and voice memo, and starts the run. Ends on the Gate 1 page.
 */
export async function startFixtureRunAtGate1(page: Page): Promise<void> {
  const input = fixtureInput();

  await test.step('register and create the project', async () => {
    const email = `e2e-journey-${Date.now()}@example.test`;
    await page.goto('/register?next=%2Fprojects%2Fnew');
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByLabel('Password').fill(`e2e-password-${Date.now()}`);
    await page.getByRole('button', { name: 'Create account' }).click();

    await page.getByLabel('Project title').fill(input.title);
    await page.getByLabel('Agency name').fill(input.agencyName);
    await page.getByLabel('Contact block').fill(input.contactBlock);
    await page.getByLabel('Tone').fill(input.tone);
    await page.getByRole('combobox', { name: /^Market/ }).selectOption({ label: 'Netherlands' });
    await page
      .getByRole('combobox', { name: /^Output language/ })
      .selectOption({ label: 'English' });
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  });

  const projectId = /\/projects\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
  expect(projectId).not.toBe('');

  await test.step('fill the fact form', async () => {
    const facts = input.factForm;
    await page
      .getByLabel('Energy label (energielabel)')
      .selectOption({ label: String(facts['energy_label']) });
    await page.getByLabel('Living area (woonoppervlakte)').fill(String(facts['living_area']));
    await page.getByLabel('Build year (bouwjaar)').fill(String(facts['build_year']));
    await page
      .getByLabel("Owners' association (VvE) monthly contribution")
      .fill(String(facts['vve_monthly_contribution']));
    await page
      .getByRole('group', { name: /Land under ground lease/ })
      .getByRole('radio', { name: facts['ground_lease'] === true ? 'Yes' : 'No', exact: true })
      .check();
    await page.getByRole('button', { name: 'Save facts' }).click();
    await expect(page.getByText('Facts saved.')).toBeVisible();

    // The street and the town are facts of the fixture's form that the market profile has no
    // control for; the recording's requests carry them, so they go in through the API, which
    // keeps everything saved above.
    const detail = projectDetailResponseSchema.parse(
      await (await page.request.get(`/api/projects/${projectId}`)).json(),
    );
    const saved = await page.request.put(`/api/projects/${projectId}/fact-form`, {
      data: {
        values: {
          ...detail.factForm.values,
          street_name: facts['street_name'] ?? null,
          place_name: facts['place_name'] ?? null,
        },
      },
    });
    expect(saved.ok()).toBe(true);
  });

  await test.step('upload the photos and the voice memo', async () => {
    await page.getByRole('link', { name: 'Add photos and walkthrough' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Capture' })).toBeVisible();
    await page.getByLabel('Photo files').setInputFiles(input.photos);
    await expect(page.getByText('11 photos uploaded.')).toBeAttached({ timeout: 60_000 });
    await page.getByLabel('Audio file').setInputFiles(input.voiceMemo);
    await page.getByRole('button', { name: 'Upload walkthrough' }).click();
    await expect(page.locator('audio[aria-label="Current walkthrough"]')).toBeVisible();
  });

  await test.step('start the run', async () => {
    await page.getByRole('link', { name: 'Back to the project' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
    await expect(page.getByText('All inputs are in place. You can start a run.')).toBeVisible();
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('region', { name: 'Review needed' })).toBeVisible({
      timeout: 120_000,
    });
    await page.getByRole('link', { name: 'Review conflicts' }).click();
    await expect(page).toHaveURL(/\/conflicts$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Resolve fact conflicts' }),
    ).toBeVisible();
  });
}
