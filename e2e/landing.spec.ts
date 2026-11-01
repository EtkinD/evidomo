import { expect, test } from '@playwright/test';

// The landing page is short and plain: a hero, three steps (10 to 30 photos and a voice
// walkthrough, no video), one claim example that opens its evidence, and three trust points.
// There is no source switch and no link to GitHub outside the footer.
test.describe('landing page', () => {
  test('the claim example is a real sentence of the sample run, one claim open at a time', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Living area' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('region', { name: /What “92 m²” is based on/ })).toContainText(
      '“92 vierkante meter”',
    );
    await expect(page.locator('mark.claim')).toHaveCount(1);

    await page.getByRole('button', { name: 'Floor' }).click();
    await expect(page.getByRole('region', { name: /What “floor 2” is based on/ })).toContainText(
      '“op de tweede verdieping”',
    );
    await expect(page.locator('mark.claim')).toHaveCount(1);
  });

  test('says what goes in: 10 to 30 photos and a voice walkthrough, and that video is not used', async ({
    page,
  }) => {
    await page.goto('/');
    const how = page.locator('#how-it-works');
    await expect(how).toContainText('10 to 30 photos');
    await expect(how).toContainText('2 to 10 minutes');
    await expect(how).toContainText('No video');
  });

  test('has no Show sources switch, and links to GitHub only from the footer', async ({ page }) => {
    await page.goto('/?sources=on');
    await expect(page.getByRole('button', { name: /sources/i })).toHaveCount(0);
    await expect(page.locator('[data-source-note]')).toHaveCount(0);
    const github = page.locator('a[href*="github.com"]');
    await expect(github).toHaveCount(1);
    await expect(page.getByRole('contentinfo').locator('a[href*="github.com"]')).toHaveCount(1);
  });

  test('the example is one action away from every width', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('main')
      .getByRole('link', { name: 'See a finished example' })
      .first()
      .click();
    await expect(page).toHaveURL(/\/demo/);
  });

  for (const width of [320, 390]) {
    test(`fits ${width} px without horizontal scroll, with 44 px targets and the action in reach`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // Strings, like capture.spec.ts: the e2e project has no DOM types.
      const overflow: unknown = await page.evaluate(
        `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      await expect(
        page.getByRole('main').getByRole('link', { name: 'See a finished example' }).first(),
      ).toBeInViewport();

      const small: string[] = [];
      for (const el of await page
        // The page's own controls: not Next's dev-mode overlay button.
        .locator(
          'header :is(a, button):visible, main :is(a, button):visible, footer :is(a, button):visible',
        )
        .all()) {
        const box = await el.boundingBox();
        if (box !== null && box.height < 43.5) small.push(`${await el.innerText()} ${box.height}`);
      }
      expect(small).toEqual([]);
    });
  }
});
