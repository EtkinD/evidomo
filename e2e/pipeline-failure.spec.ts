import { expect, test } from '@playwright/test';
import { startFixtureRunAtGate1 } from './support/pipeline.ts';

// The failed-run journey, deterministically and with zero model calls: Gate 1 is decided with a
// choice the cassette holds no recording for, so the replay worker fails the next step at once
// with its own reason (docs/architecture.md section 5, "What a replay can follow") instead of
// calling the model. The UI then has to show where the run stopped and offer the resume.
test.skip(Boolean(process.env['E2E_BASE_URL']), 'creates accounts; local stack only');
test.skip(process.env['E2E_ISOLATED'] !== '1', 'needs the replay worker of the isolated stack');

test('a step the recording cannot replay fails the run, and the failure can be resumed', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await startFixtureRunAtGate1(page);

  await test.step('decide Gate 1 off the recorded path', async () => {
    await page.getByRole('button', { name: 'Use this value: 1986' }).click();
    await page.getByRole('button', { name: 'Reject all values for Bedroom floor' }).click();
    await page.getByRole('button', { name: 'Use this value: € 175' }).click();
    await expect(page.getByText('All conflicts are decided. The run is continuing.')).toBeVisible();
    await page.getByRole('link', { name: 'Back to run' }).click();
  });

  const failure = page.getByRole('region', { name: 'The run failed' });
  await test.step('the failure says where, why, and what is kept', async () => {
    await expect(failure).toBeVisible({ timeout: 120_000 });
    await expect(failure.getByText(/^Stopped at: /)).toBeVisible();
    await expect(failure.getByText(/Development replay has no recording/)).toBeVisible();
    await expect(failure.getByText(/Finished steps are kept: \d+ of 10/)).toBeVisible();
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Looking at the photos' }),
    ).toContainText('Done');
  });

  await test.step('resuming is accepted, and the run ends in the same failure', async () => {
    await failure.getByRole('button', { name: 'Resume run' }).click();
    await expect(page.getByText('Resumed from “Writing the listing”')).toBeVisible();
    // The recording still holds nothing for this path, so the step fails again at once. What this
    // checks is that the resume was accepted (the API answered, the message names the step) and
    // that the page does not end up in a broken state; it cannot tell the first failure from the
    // second, because both read the same.
    await expect(failure.getByText(/Development replay has no recording/)).toBeVisible();
  });
});
