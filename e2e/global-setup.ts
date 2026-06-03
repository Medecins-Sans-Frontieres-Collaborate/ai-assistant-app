import { encode } from 'next-auth/jwt';

import {
  E2E_SESSION_COOKIE,
  E2E_STORAGE_STATE,
  E2E_TEST_SECRET,
} from './constants';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Playwright global setup.
 *
 * Mints a NextAuth session cookie out-of-band and writes it as a Playwright
 * storage state, so tests start already authenticated without performing a
 * real Microsoft login (and therefore without touching MFA). No production
 * code path is bypassed — the app validates this cookie exactly as it would a
 * real one; the only thing that makes it valid is the shared test-only secret.
 */
async function globalSetup(): Promise<void> {
  // Safety guard: the test secret must never coincide with a real secret that
  // happens to be present in the environment. If it did, a cookie minted here
  // could be a valid PRODUCTION session.
  for (const name of ['AUTH_SECRET', 'NEXTAUTH_SECRET'] as const) {
    if (process.env[name] && process.env[name] === E2E_TEST_SECRET) {
      throw new Error(
        `Refusing to run E2E: ${name} equals the E2E test secret. ` +
          'The test secret must be distinct from any real secret.',
      );
    }
  }

  // Far-future expiry so the NextAuth jwt callback treats the access token as
  // still valid and never attempts a (network) refresh against Microsoft when
  // the session is read. Guarantees zero outbound auth calls during tests.
  const accessTokenExpires = 4_102_444_800_000; // 2100-01-01

  const token = await encode({
    salt: E2E_SESSION_COOKIE,
    secret: E2E_TEST_SECRET,
    maxAge: 30 * 24 * 60 * 60,
    token: {
      sub: 'e2e-user',
      userId: 'e2e-user',
      userDisplayName: 'E2E User',
      userMail: 'e2e@example.com',
      userRegion: 'EU',
      accessTokenExpires,
      refreshToken: 'e2e-dummy-refresh-token',
    },
  });

  const storageState = {
    cookies: [
      {
        name: E2E_SESSION_COOKIE,
        value: token,
        domain: 'localhost',
        path: '/',
        // Session cookie (no explicit expiry needed for the test run).
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [] as Array<{ origin: string; localStorage: unknown[] }>,
  };

  await mkdir(dirname(E2E_STORAGE_STATE), { recursive: true });
  await writeFile(E2E_STORAGE_STATE, JSON.stringify(storageState, null, 2));
}

export default globalSetup;
