import { expect, test } from '@playwright/test';

// /method is the detail page the landing page leaves out: four numbered sections, each ending with
// its sources. It is reached from the masthead, the colophon, and the landing page.
test.describe('method page', () => {
  test('is reached from the masthead, the landing page, and the colophon', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'Method' }).click();
    await expect(page).toHaveURL(/\/method$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'How Evidomo checks a listing' }),
    ).toBeVisible();

    await page.goto('/');
    await page
      .getByRole('main')
      .getByRole('link', { name: 'How Evidomo checks a listing' })
      .click();
    await expect(page).toHaveURL(/\/method$/);

    await page.goto('/');
    await page
      .getByRole('contentinfo')
      .getByRole('link', { name: 'How Evidomo checks a listing' })
      .click();
    await expect(page).toHaveURL(/\/method$/);
  });

  test('the index and the landing page notes reach the sections by their anchors', async ({
    page,
  }) => {
    await page.goto('/method');
    const index = page.getByRole('navigation', { name: 'On this page' });
    for (const [name, anchor] of [
      ['What happened to the sample listing', 'sample-run'],
      ['The numbers, and their limits', 'numbers'],
      ['What it will not do, and what it removes', 'limits-and-data'],
      ['Every claim has a source', 'sources'],
    ] as const) {
      await index.getByRole('link', { name }).click();
      await expect(page).toHaveURL(new RegExp(`#${anchor}$`));
      await expect(page.locator(`#${anchor}`)).toBeInViewport();
    }

    // A landing page source note leads to the matching section.
    await page.goto('/?sources=on');
    await page.getByRole('main').getByRole('link', { name: 'Method, § 2' }).first().click();
    await expect(page).toHaveURL(/\/method#sample-run$/);
    await expect(page.locator('#sample-run')).toBeInViewport();
  });

  test('the specimen opens a claim at a time, and every section ends with sources', async ({
    page,
  }) => {
    await page.goto('/method');
    await expect(page.getByRole('region', { name: /What “1987” rests on/ })).toContainText(
      'Build year: 1986',
    );
    await page.getByRole('button', { name: 'Energy label' }).click();
    await expect(page.getByRole('region', { name: /energy label B/ })).toContainText(
      '“Het energielabel is B”',
    );
    await expect(page.locator('[data-method-sources]')).toHaveCount(4);
    await expect(page.locator('mark.claim')).toHaveCount(1);
  });

  for (const width of [320, 390]) {
    test(`fits ${width} px without horizontal scroll, with 44 px targets, masthead included`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ['/method', '/']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        // Strings, like capture.spec.ts: the e2e project has no DOM types.
        const overflow: unknown = await page.evaluate(
          `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
        );
        expect(overflow, path).toBeLessThanOrEqual(0);

        const small: string[] = [];
        for (const el of await page
          .locator(
            'header :is(a, button):visible, main :is(a, button):visible, footer :is(a, button):visible',
          )
          .all()) {
          const box = await el.boundingBox();
          if (box !== null && box.height < 43.5)
            small.push(`${await el.innerText()} ${box.height}`);
        }
        expect(small, path).toEqual([]);
      }
    });
  }
});
