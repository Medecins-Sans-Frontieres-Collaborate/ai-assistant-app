/**
 * Shared constants for the Playwright E2E harness.
 *
 * The E2E suite never performs a real Microsoft login. Instead, global-setup
 * mints a NextAuth session cookie out-of-band, signed with the test-only
 * secret below, and the app-under-test is started with the SAME secret. This
 * means no production auth code path is altered — the app validates the cookie
 * exactly as it would in production; only this (deliberately fake) secret is
 * shared between the cookie minter and the test server.
 *
 * This secret is intentionally obvious and must NEVER match a real secret.
 */
export const E2E_TEST_SECRET =
  'e2e-test-only-secret-do-not-use-in-production-0000';

/** Port for the dedicated test server (separate from the dev server on 3000). */
export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/**
 * Dev (http) NextAuth session cookie name. In production (https) NextAuth uses
 * the `__Secure-` prefixed name, but the E2E server runs over http, so the
 * unprefixed name applies. NextAuth derives the JWE salt from this name, so it
 * is used as the `salt` when encoding the cookie.
 */
export const E2E_SESSION_COOKIE = 'authjs.session-token';

/**
 * Where the minted Playwright storage states are written.
 * - The default (EU) user exercises the terms-acceptance gate.
 * - The US user is terms-exempt, used to assert the composer is immediately usable.
 */
export const E2E_STORAGE_STATE = 'e2e/.auth/state.json';
export const E2E_STORAGE_STATE_US = 'e2e/.auth/state-us.json';
