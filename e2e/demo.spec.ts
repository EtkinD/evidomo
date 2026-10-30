import { expect, test } from '@playwright/test';

// The standard e2e stack publishes no demo run (DEMO_RUN_IDS is unset), so this covers what is
// true without one: the public pages exist, need no login, carry the banner, and are reachable
// from the landing page and the header. Replaying a run needs a seeded database (P5-05).
test.describe('demo, signed out', () => {
  test('the header leads to the public demo page, which needs no login', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'Demo' }).click();

    await expect(page).toHaveURL(/\/demo$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'See Evidomo at work' }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'About this demo' })).toContainText(
      'replay of a sample run',
    );
    // Either the explanation (nothing published) or the runs (a stack that has one); never a
    // login redirect or a dead end.
    const main = page.getByRole('main');
    await expect(
      main.getByText('No demo is published yet').or(main.getByRole('listitem').first()),
    ).toBeVisible();
  });

  test('the landing page links to the demo', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('main').getByRole('link', { name: 'See a finished run' }).first().click();
    await expect(page).toHaveURL(/\/demo$/);
  });

  test('a run that is not published answers with a not-found state', async ({ page }) => {
    await page.goto('/demo/runs/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('region', { name: 'About this demo' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'This demo run was not found',
    );
    await expect(page.getByRole('link', { name: 'See the demo runs' })).toBeVisible();
  });
});
