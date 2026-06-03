import { expect, test } from '@playwright/test';

/**
 * Unauthenticated access must be redirected to the sign-in page by the auth
 * middleware (proxy.ts redirects when `!req.auth`). Runs with an empty storage
 * state to override the default authenticated state. No cookie is sent and no
 * external service is contacted.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test('redirects unauthenticated users to /signin', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/signin/);
});
