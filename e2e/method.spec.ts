import { expect, test } from '@playwright/test';

// /method is the detail page the landing page leaves out: five numbered sections in plain words
// (what goes in, where a sentence comes from, the example, the tests, the limits). It is reached
// from the masthead, the colophon, and the landing page, and it links nowhere but the footer's
// GitHub link.
test.describe('method page', () => {
  test('is reached from the masthead, the landing page, and the colophon', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'How it works' }).click();
    await expect(page).toHaveURL(/\/method$/);
    await expect(page.getByRole('heading', { level: 1, name: 'How Evidomo works' })).toBeVisible();

    await page.goto('/');
    await page.getByRole('main').getByRole('link', { name: 'How Evidomo works' }).click();
    await expect(page).toHaveURL(/\/method$/);

    await page.goto('/');
    await page.getByRole('contentinfo').getByRole('link', { name: 'How Evidomo works' }).click();
    await expect(page).toHaveURL(/\/method$/);
  });

  test('the index reaches the sections by their anchors', async ({ page }) => {
    await page.goto('/method');
    const index = page.getByRole('navigation', { name: 'On this page' });
    for (const [name, anchor] of [
      ['What you give it', 'inputs'],
      ['What happened to the example listing', 'example'],
      ['How well does it work?', 'tests'],
      ['What it will not do', 'limits'],
      ['Where every sentence comes from', 'sources'],
    ] as const) {
      await index.getByRole('link', { name }).click();
      await expect(page).toHaveURL(new RegExp(`#${anchor}$`));
      await expect(page.locator(`#${anchor}`)).toBeInViewport();
    }
  });

  test('says what goes in, opens a claim at a time, and links to GitHub only from the footer', async ({
    page,
  }) => {
    await page.goto('/method');
    await expect(page.locator('#inputs')).toContainText('10 to 30 photos');
    await expect(page.locator('#inputs')).toContainText('Evidomo does not use video');
    await expect(page.getByRole('region', { name: /What “1987” is based on/ })).toContainText(
      'Year built: 1986',
    );
    await page.getByRole('button', { name: 'Energy label' }).click();
    await expect(page.getByRole('region', { name: /energy label B/ })).toContainText(
      '“Het energielabel is B”',
    );
    await expect(page.locator('mark.claim')).toHaveCount(1);
    await expect(page.locator('a[href*="github.com"]')).toHaveCount(1);
    await expect(page.getByRole('contentinfo').locator('a[href*="github.com"]')).toHaveCount(1);
  });

  test('separates footnote markers from the numbers and says which example the numbers come from', async ({
    page,
  }) => {
    await page.goto('/method');
    const sentence = page.locator('blockquote[lang="en"]');
    await expect(sentence).toContainText('1987[1]');
    await expect(sentence.locator('sup .sr-only').first()).toHaveText(', Note 1');
    const note = page.locator('#example').getByText(/These numbers are from one example/);
    await expect(note).toContainText('Zandmeer');
    await expect(note.getByRole('link', { name: 'All examples' })).toHaveAttribute('href', '/demo');
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
