import {
  E2E_BASE_URL,
  E2E_PORT,
  E2E_STORAGE_STATE,
  E2E_TEST_SECRET,
} from './e2e/constants';

import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config.
 *
 * - Lives in `e2e/` so it never overlaps with the Vitest suites in `__tests__/`.
 * - Authenticates by injecting an out-of-band-minted NextAuth cookie
 *   (see e2e/global-setup.ts) — no real Microsoft login, no MFA bypass in app code.
 * - Starts its OWN Next dev server on a dedicated port with a test-only secret and
 *   no real service endpoints, so nothing dials a paid Azure/OpenAI/Graph service.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: E2E_BASE_URL,
    storageState: E2E_STORAGE_STATE,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Plain `next dev` on a dedicated port. process.env is merged in by
    // Playwright; the overrides below take precedence (Next will not overwrite
    // an env var that is already set), so the test-only secret wins over any
    // value in .env files.
    command: `npx next dev -p ${E2E_PORT}`,
    url: E2E_BASE_URL,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      NODE_OPTIONS: '--max-http-header-size=32768',
      // Test-only auth secret — MUST match the secret used to mint the cookie.
      AUTH_SECRET: E2E_TEST_SECRET,
      NEXTAUTH_SECRET: E2E_TEST_SECRET,
      // http URL → NextAuth uses the unprefixed `authjs.session-token` cookie.
      NEXTAUTH_URL: E2E_BASE_URL,
      AUTH_URL: E2E_BASE_URL,
      AUTH_TRUST_HOST: 'true',
    },
  },
});
