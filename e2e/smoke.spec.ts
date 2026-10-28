import { expect, test } from '@playwright/test';

test('home page loads', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/Evidomo/);
  await expect(page.getByRole('heading', { level: 1, name: 'Evidomo' })).toBeVisible();
});
