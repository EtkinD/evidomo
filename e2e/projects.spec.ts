import { expect, test } from '@playwright/test';

// Creates an account and a project, so it runs against the local stack only.
test.skip(Boolean(process.env['E2E_BASE_URL']), 'creates accounts; local stack only');

test('register, create a project, fill the fact form, and see what is still missing', async ({
  page,
}) => {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

  await page.goto('/register?next=%2Fprojects');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByLabel('Password').fill(`e2e-password-${Date.now()}`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your projects' })).toBeVisible();

  // Empty state, then the create form.
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await page.getByRole('link', { name: 'New project' }).first().click();
  await expect(page).toHaveURL('/projects/new');

  // Validation runs before any request.
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText('Enter a project title.')).toBeVisible();

  await page.getByLabel('Project title').fill('Zandmeer Lane 100');
  await page.getByLabel('Agency name').fill('E2E Realty');
  await page.getByLabel('Market').selectOption({ label: 'Netherlands' });
  // The language list follows the market, defaulting to its default language.
  await expect(page.getByLabel('Output language')).toHaveValue('en');
  await page.getByLabel('Output language').selectOption({ label: 'Dutch' });
  await page.getByRole('button', { name: 'Create project' }).click();

  // The project page lists what is missing, with the required facts named.
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Zandmeer Lane 100' })).toBeVisible();
  const readiness = page.getByRole('region', { name: 'Ready to run?' });
  await expect(readiness.getByText(/Fill in the required fact: Living area/)).toBeVisible();
  await expect(readiness.getByText(/Fill in the required fact: Energy label/)).toBeVisible();
  await expect(readiness.getByRole('button', { name: 'Start run' })).toBeDisabled();

  // The access code field is always offered (the server ignores it when no code is configured).
  // Starting a run would make model calls, so only the field itself is exercised here.
  const accessCode = readiness.getByLabel('Access code');
  await expect(accessCode).toHaveAttribute('type', 'password');
  await readiness.getByRole('button', { name: 'Show access code' }).click();
  await expect(accessCode).toHaveAttribute('type', 'text');

  // A bad value is refused before saving; a good one is saved and clears the fact from the list.
  await page.getByLabel(/Living area/).fill('-5');
  await page.getByRole('button', { name: 'Save facts' }).click();
  await expect(page.getByText('Enter a number of 0 or more.')).toBeVisible();
  // Text the browser could not parse as a number must never read as "cleared".
  await page.getByLabel(/Living area/).fill('abc');
  await page.getByRole('button', { name: 'Save facts' }).click();
  await expect(page.getByText(/Enter a number, using one comma or point/)).toBeVisible();
  // A decimal comma is understood, whatever the browser's locale.
  await page.getByLabel(/Living area/).fill('92,5');
  await page.getByLabel(/Energy label/).selectOption('B');
  await page.getByRole('button', { name: 'Save facts' }).click();
  await expect(page.getByText('Facts saved.')).toBeVisible();
  await expect(readiness.getByText(/Fill in the required fact/)).toHaveCount(0);
  await expect(readiness.getByText(/Record a voice walkthrough/)).toBeVisible();

  // The saved values survive a reload, and the project is in the list.
  await page.reload();
  await expect(page.getByLabel(/Living area/)).toHaveValue('92.5');
  // A rejected value leaves the stored one alone.
  await page.getByLabel(/Living area/).fill('abc');
  await page.getByRole('button', { name: 'Save facts' }).click();
  await expect(page.getByText(/Enter a number, using one comma or point/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Living area/)).toHaveValue('92.5');
  await page.getByRole('link', { name: 'Back to projects' }).first().click();
  await expect(page.getByRole('link', { name: 'Zandmeer Lane 100' })).toBeVisible();
  await expect(page.getByText('No run yet')).toBeVisible();
});
