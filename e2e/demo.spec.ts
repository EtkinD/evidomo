import { expect, test, type APIRequestContext } from '@playwright/test';

// The standard e2e stack publishes no demo run (DEMO_RUN_IDS is unset), so by default this covers
// what is true without one: the public pages exist, need no login, carry the running head, and are
// reachable from the landing page and the header. The entry is also right on a stack that
// publishes exactly one run (it opens that run: the cover and the folder tabs) or several (a list):
// the tests ask the demo API which case they are in. Replaying a run needs a seeded database.
async function publishedRunIds(request: APIRequestContext): Promise<string[]> {
  const response = await request.get('/api/demo/runs');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { runs: { id: string }[] };
  return body.runs.map((run) => run.id);
}

test.describe('demo, signed out', () => {
  test('the header leads to the public demo, which needs no login', async ({ page, request }) => {
    const ids = await publishedRunIds(request);
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'Demo' }).click();

    const head = page.getByRole('region', { name: 'About this demo' });
    await expect(head).toContainText('replay of a synthetic run');
    const main = page.getByRole('main');

    if (ids.length === 1) {
      // One published run: the entry opens the sample file itself, with its folder tabs.
      // (The dev server compiles the run screen on its first visit, which can take a while.)
      const slow = { timeout: 30_000 };
      await expect(page).toHaveURL(new RegExp(`/demo/runs/${ids[0]}$`), slow);
      await expect(
        page.getByRole('navigation', { name: 'Sections of the sample file' }),
      ).toBeVisible(slow);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible(slow);
      // No autoplay: the replay waits for the button (not pressed here, so this stays read-only).
      await expect(page.getByRole('button', { name: 'Start the demo' })).toBeVisible(slow);
    } else {
      await expect(page).toHaveURL(/\/demo$/);
      await expect(
        page.getByRole('heading', { level: 1, name: 'See Evidomo at work' }),
      ).toBeVisible();
      // Either the explanation (nothing published) or the runs; never a login redirect.
      await expect(
        main.getByText('No demo is published yet').or(main.getByRole('listitem').first()),
      ).toBeVisible();
    }
  });

  test('the landing page links to the demo', async ({ page, request }) => {
    const ids = await publishedRunIds(request);
    await page.goto('/');
    await page
      .getByRole('main')
      .getByRole('link', { name: 'Open the sample file' })
      .first()
      .click();
    await expect(page).toHaveURL(
      ids.length === 1 ? new RegExp(`/demo/runs/${ids[0]}$`) : /\/demo$/,
      { timeout: 30_000 },
    );
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
