import { encode } from 'next-auth/jwt';

import {
  E2E_SESSION_COOKIE,
  E2E_STORAGE_STATE,
  E2E_STORAGE_STATE_US,
  E2E_TEST_SECRET,
} from './constants';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Far-future expiry so the NextAuth jwt callback treats the access token as
// still valid and never attempts a (network) refresh against Microsoft when the
// session is read. Guarantees zero outbound auth calls during tests.
const ACCESS_TOKEN_EXPIRES = 4_102_444_800_000; // 2100-01-01

/**
 * Mint a NextAuth session cookie for a given region and write it as a Playwright
 * storage state file. No production code path is bypassed — the app validates
 * this cookie exactly as it would a real one; the only thing that makes it valid
 * is the shared test-only secret.
 *
 * The region matters: EU users hit the terms-acceptance gate, US users are
 * exempt (see components/Terms/TermsAcceptanceProvider.tsx).
 */
async function mintState(region: 'EU' | 'US', outPath: string): Promise<void> {
  const slug = region.toLowerCase();
  const token = await encode({
    salt: E2E_SESSION_COOKIE,
    secret: E2E_TEST_SECRET,
    maxAge: 30 * 24 * 60 * 60,
    token: {
      sub: `e2e-${slug}-user`,
      userId: `e2e-${slug}-user`,
      userDisplayName: `E2E ${region} User`,
      userMail: `e2e-${slug}@example.com`,
      userRegion: region,
      accessTokenExpires: ACCESS_TOKEN_EXPIRES,
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

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(storageState, null, 2));
}

/**
 * Playwright global setup. Mints two authenticated storage states out-of-band
 * (an EU user — the default, terms-gated — and a US user — terms-exempt) so
 * tests start authenticated without a real Microsoft login or MFA.
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

  await mintState('EU', E2E_STORAGE_STATE);
  await mintState('US', E2E_STORAGE_STATE_US);
}

export default globalSetup;
