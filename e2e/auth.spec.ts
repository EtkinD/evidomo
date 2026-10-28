import { expect, test } from '@playwright/test';

// Creates an account, so it runs against the local stack only, never a deployment.
test.skip(Boolean(process.env['E2E_BASE_URL']), 'creates accounts; local stack only');

test('register, log out, get redirected to login, and log back in', async ({ page }) => {
  // Unique per run; the reserved .test TLD never reaches a real mailbox.
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = `e2e-password-${Date.now()}`;
  const projectsHeading = page.getByRole('heading', { level: 1, name: 'Your projects' });

  // A signed-out visitor is sent to login, remembering where they wanted to go.
  await page.goto('/projects');
  await expect(page).toHaveURL('/login?next=%2Fprojects');

  // Register (which also signs in) and land on the protected page.
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page).toHaveURL('/register?next=%2Fprojects');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/projects');
  await expect(projectsHeading).toBeVisible();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();

  // The session survives a full reload (httpOnly cookie, checked through GET /api/auth/me).
  await page.reload();
  await expect(projectsHeading).toBeVisible();

  // Log out: back to the landing page, and the protected page redirects again.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
  await page.goto('/projects');
  await expect(page).toHaveURL('/login?next=%2Fprojects');
  await expect(projectsHeading).toBeHidden();

  // A wrong password gets the generic message.
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByLabel('Password').fill(`${password}-wrong`);
  await page.getByRole('button', { name: 'Log in' }).click();
  // Scoped to main: Next's route announcer is also a live `alert` region.
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'Email or password is incorrect.',
  );

  // Log in and land back on the page.
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL('/projects');
  await expect(projectsHeading).toBeVisible();
});

test('a signed-out visitor cannot be bounced off-site through next', async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent('//evil.example/phish')}`);
  await expect(page.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
    'href',
    '/register',
  );
});
