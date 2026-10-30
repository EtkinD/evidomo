import { expect, test } from '@playwright/test';

test('home page loads', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/Evidomo/);
  await expect(
    page.getByRole('heading', { level: 1, name: /linked to its evidence/ }),
  ).toBeVisible();
});
