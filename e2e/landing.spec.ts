import { expect, test } from '@playwright/test';

// The landing page is an audited page: a specimen, the sample run's ledger, the eval numbers, and
// the boundaries, with a "Show sources" switch that marks every claim with its source.
test.describe('landing page', () => {
  test('opens on a real sentence of the sample run with its first claim open', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Build year' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const evidence = page.getByRole('region', { name: /What “1987” rests on/ });
    await expect(evidence).toContainText('“in 1987 gebouwd”');

    await page.getByRole('button', { name: 'Energy label' }).click();
    await expect(page.getByRole('region', { name: /energy label B/ })).toContainText(
      '“Het energielabel is B”',
    );
  });

  test('Show sources marks the claims, is keyboard operable, and is remembered', async ({
    page,
  }) => {
    await page.goto('/');
    const main = page.getByRole('main');
    const toggle = page.getByRole('banner').getByRole('button', { name: 'Show sources' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(main.locator('[data-source-note]')).toHaveCount(0);

    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(await main.locator('[data-source-note]').count()).toBeGreaterThan(20);
    await expect(main.getByRole('link', { name: 'apps/api/src/media/image.ts' })).toHaveAttribute(
      'href',
      'https://github.com/EtkinD/evidomo/blob/main/apps/api/src/media/image.ts',
    );

    await page.reload();
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Show sources' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('banner').getByRole('button', { name: 'Show sources' }).click();
    await page.reload();
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Show sources' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  test('?sources=on turns the sources on for a shared link', async ({ page }) => {
    await page.goto('/?sources=on');
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Show sources' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('[data-source-note]').count()).toBeGreaterThan(20);
  });

  test('the sample file is one action away from every width', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('main')
      .getByRole('link', { name: 'Open the sample file' })
      .first()
      .click();
    await expect(page).toHaveURL(/\/demo/);
  });

  for (const width of [320, 390]) {
    test(`fits ${width} px without horizontal scroll, with 44 px targets and the bar in reach`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?sources=on');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // Strings, like capture.spec.ts: the e2e project has no DOM types.
      const overflow: unknown = await page.evaluate(
        `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // The phone bar holds the switch and the action; the masthead copy of the switch is hidden.
      await expect(
        page.getByRole('main').getByRole('button', { name: 'Show sources' }),
      ).toBeVisible();
      await expect(
        page.getByRole('main').getByRole('link', { name: 'Open the sample file' }).last(),
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
