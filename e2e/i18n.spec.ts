import { expect, test } from '@playwright/test';

// The existing specs run in Playwright's default locale (en-US) and stay English. These open the
// landing page with other browser languages: Next's i18n routing reads Accept-Language on the
// first visit to `/`.

test.describe('browser language Turkish', () => {
  test.use({ locale: 'tr-TR' });

  test('/ lands on the Turkish pages and marks the document language', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL(/\/tr$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Her cümlenin kaynağını gösteren bir ilan.' }),
    ).toBeVisible();
    // The per-language Open Graph image and the language alternates ride along.
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      /\/og-tr\.png$/,
    );
    await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1);
  });

  test('a language chosen in the footer sticks over the browser language', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/tr$/);

    await page
      .getByRole('navigation', { name: 'Dil' })
      .getByRole('link', { name: 'English' })
      .click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    // The switcher set NEXT_LOCALE=en: a new visit to / stays English although the browser asks for Turkish.
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/tr/);
    await expect(
      page.getByRole('heading', { level: 1, name: /every sentence shows where it came from/ }),
    ).toBeVisible();
  });
});

test.describe('the language menu in the header', () => {
  test('a visitor on a deep link switches language from the masthead', async ({ page }) => {
    await page.goto('/method');
    const button = page.getByRole('banner').getByRole('button', { name: 'Language: English' });
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    await button.click();
    await page.getByRole('banner').getByRole('link', { name: 'Türkçe' }).click();
    await expect(page).toHaveURL(/\/tr\/method$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Dil: Türkçe' }),
    ).toBeVisible();
    // The footer switcher still works next to it.
    await expect(page.getByRole('navigation', { name: 'Dil' })).toBeVisible();
  });
});

test.describe('a browser language the app does not offer', () => {
  test.use({ locale: 'de-DE' });

  test('/ stays English', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByRole('heading', { level: 1, name: /every sentence shows where it came from/ }),
    ).toBeVisible();
  });
});

test('every language has a Turkish, Dutch, Italian, and Spanish landing page under its prefix', async ({
  page,
}) => {
  const headings: Record<string, string> = {
    tr: 'Her cümlenin kaynağını gösteren bir ilan.',
    nl: 'Een advertentie waarin elke zin laat zien waar hij vandaan komt.',
    it: 'Un annuncio in cui ogni frase mostra da dove viene.',
    es: 'Un anuncio donde cada frase muestra de dónde sale.',
  };
  for (const [locale, name] of Object.entries(headings)) {
    await page.goto(`/${locale}`);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  }
});
