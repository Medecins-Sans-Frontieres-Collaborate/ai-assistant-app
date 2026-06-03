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
    // Production build + `next start` on a dedicated port. We deliberately do
    // NOT use `next dev`: dev compiles routes on demand at first request, so on
    // a cold CI runner the first authenticated navigation triggers a multi-
    // second compile of the heavy `[locale]/(auth)/(chat)` route that blows past
    // the per-test timeout (and `fullyParallel` makes sibling tests race the
    // same cold compile, producing ERR_ABORTED). A prod build precompiles every
    // route, so navigation is deterministic.
    //
    // process.env is merged in by Playwright; the overrides below take
    // precedence (Next will not overwrite an env var that is already set), so
    // the test-only secret wins over any value in .env files. AUTH_URL is http,
    // so Auth.js keeps the unprefixed `authjs.session-token` cookie even though
    // `next start` runs in production mode — matching the minted cookie.
    command: `npm run build && npx next start -p ${E2E_PORT}`,
    url: E2E_BASE_URL,
    // Generous: a cold prod build on a CI runner can take a few minutes.
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      NODE_OPTIONS: '--max-http-header-size=32768',
      // `next build` runs with NODE_ENV=production and loads `.env.production`,
      // which sets `NEXT_PUBLIC_ENV=production` — NOT a valid value for the
      // config/environment.ts enum (localhost|dev|staging|beta|live|prod), so
      // the build aborts with "Invalid environment variables". Real deploys
      // override this via Docker build-args; the E2E plain build does it here.
      // process.env wins over .env files in Next, so this applies to build+start.
      NEXT_PUBLIC_ENV: 'localhost',
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
