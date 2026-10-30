import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { portalFieldsSchema } from '@evidomo/shared';
import { startFixtureRunAtGate1 } from './support/pipeline.ts';

// The whole product journey through the real UI, API, and worker, with zero model calls: the
// isolated stack's worker is the replay worker (playwright.config.ts), and the project is the
// synthetic fixture's (e2e/support/pipeline.ts).
test.skip(Boolean(process.env['E2E_BASE_URL']), 'creates accounts; local stack only');
// Without the isolated stack a developer's live `dev:worker` would pick the run up and spend.
test.skip(process.env['E2E_ISOLATED'] !== '1', 'needs the replay worker of the isolated stack');

test('capture, run, Gate 1, Gate 2, and export', async ({ page }) => {
  test.setTimeout(150_000);
  await startFixtureRunAtGate1(page);

  await test.step("decide Gate 1 as the fixture's scripted decisions", async () => {
    // decisions.json: the walkthrough's build year; otherwise the form's value, or a rejection
    // where the form has none (the bedroom floor is a walkthrough-versus-photo contradiction).
    // Only decisions the recording holds can be replayed (architecture.md section 5).
    await page.getByRole('button', { name: 'Use this value: 1987' }).click();
    await expect(page.getByText('2 of 3 conflicts still open')).toBeVisible();
    await page.getByRole('button', { name: 'Reject all values for Bedroom floor' }).click();
    await expect(page.getByText('1 of 3 conflicts still open')).toBeVisible();
    await page.getByRole('button', { name: 'Use this value: € 175' }).click();
    await expect(page.getByText('All conflicts are decided. The run is continuing.')).toBeVisible();
  });

  await test.step('the run continues to Gate 2', async () => {
    await page.getByRole('link', { name: 'Back to run' }).click();
    await expect(page.getByRole('region', { name: 'Review needed' })).toBeVisible({
      timeout: 120_000,
    });
    await page.getByRole('link', { name: 'Review the pack' }).click();
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Review the pack' })).toBeVisible();
  });

  await test.step('every sentence opens its evidence', async () => {
    const sentence = page.getByRole('button', {
      name: /^Show evidence for: This apartment in Zandmeer offers 92 m²/,
    });
    await sentence.click();
    await expect(page.getByRole('heading', { name: /^Evidence for / })).toBeVisible();
    await page.getByRole('button', { name: 'Close evidence' }).click();
    await expect(page.getByRole('heading', { name: /^Evidence for / })).toHaveCount(0);
  });

  await test.step('decide Gate 2 and approve the pack', async () => {
    // The recording has no flagged claim (decisions.json would remove any); the one open item
    // is the staged image, which the scripted decisions accept.
    await expect(page.getByText('Flagged claims: 0 (0 open)')).toBeVisible();
    await page
      .getByRole('button', { name: 'Accept staged image: Furnish bedroom (photo 1)' })
      .click();
    await expect(
      page.getByText('Everything is decided. Approving starts the export of the pack.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Approve pack' }).click();
  });

  await test.step('the export completes and the pack opens', async () => {
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('region', { name: 'Run finished' })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole('link', { name: 'View pack' }).click();
    await expect(page).toHaveURL(/\/pack$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Listing pack' })).toBeVisible();
  });

  await test.step('the pack renders and its portal fields download', async () => {
    await expect(page.getByText('Ready to publish: every publication check passed.')).toBeVisible();
    const preview = page.frameLocator('iframe[title="Listing pack preview"]');
    await expect(preview.locator('body')).toContainText('Zandmeer');

    const downloading = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download portal-fields.json' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('portal-fields.json');
    const text = readFileSync(await download.path(), 'utf8');
    const portalFields = portalFieldsSchema.parse(JSON.parse(text));
    // Gate 1 chose the walkthrough's build year and the form's contribution.
    const verified = Object.fromEntries(
      portalFields.facts.profile
        .filter((fact) => fact.status === 'verified')
        .map((fact) => [fact.key, fact.value]),
    );
    expect(verified).toMatchObject({ build_year: 1987, vve_monthly_contribution: 175 });
    expect(text).toContain('Zandmeer');
  });
});
