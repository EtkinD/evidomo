import { expect, type Page } from '@playwright/test';

export async function createProjectAndOpenCapture(page: Page): Promise<void> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  await page.goto('/register?next=%2Fprojects%2Fnew');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByLabel('Password').fill(`e2e-password-${Date.now()}`);
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByLabel('Project title').fill('Capture Lane 7');
  await page.getByLabel('Agency name').fill('E2E Realty');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);

  await page.getByRole('link', { name: 'Add photos and walkthrough' }).click();
  await expect(page).toHaveURL(/\/capture$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Capture' })).toBeVisible();
}
