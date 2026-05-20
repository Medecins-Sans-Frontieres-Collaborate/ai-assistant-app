import { isAllowedFoundryHost } from '@/lib/utils/shared/foundryHostAllowlist';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/environment', () => ({
  env: {
    AZURE_AI_FOUNDRY_ENDPOINT:
      'https://default.services.ai.azure.com/api/projects/default',
    AZURE_AI_FOUNDRY_ENDPOINT_US:
      'https://us.services.ai.azure.com/api/projects/default',
    AZURE_AI_FOUNDRY_ENDPOINT_EU:
      'https://eu.services.ai.azure.com/api/projects/default',
  },
}));

describe('isAllowedFoundryHost', () => {
  it('accepts a real Foundry host', () => {
    expect(
      isAllowedFoundryHost(
        'https://account.services.ai.azure.com/api/projects/default',
      ),
    ).toBe(true);
  });

  it('accepts a Cognitive Services host', () => {
    expect(
      isAllowedFoundryHost('https://account.cognitiveservices.azure.com/foo'),
    ).toBe(true);
  });

  it('rejects http:// (bearer token would be sent in the clear)', () => {
    expect(isAllowedFoundryHost('http://account.services.ai.azure.com/')).toBe(
      false,
    );
  });

  it('rejects suffix-spoofing attempts', () => {
    expect(
      isAllowedFoundryHost(
        'https://attacker.com.services.ai.azure.com.evil.com/',
      ),
    ).toBe(false);
    expect(
      isAllowedFoundryHost('https://services.ai.azure.com.evil.com/'),
    ).toBe(false);
  });

  it('rejects hosts that merely contain the suffix mid-string', () => {
    expect(
      isAllowedFoundryHost('https://services.ai.azure.com.attacker.com/'),
    ).toBe(false);
  });

  it('rejects attacker host with allow-listed suffix as URL path/fragment', () => {
    expect(
      isAllowedFoundryHost('https://attacker.com/.services.ai.azure.com'),
    ).toBe(false);
    expect(
      isAllowedFoundryHost('https://attacker.com#.services.ai.azure.com'),
    ).toBe(false);
  });

  it('handles userinfo in URL — host is the actual destination', () => {
    // userinfo doesn't change the destination — this resolves to a real Foundry
    // host so it's allowed. The bearer token still ends up at Microsoft.
    expect(
      isAllowedFoundryHost('https://attacker@real.services.ai.azure.com/'),
    ).toBe(true);
    // ...but a userinfo trick to a fake host is still blocked.
    expect(
      isAllowedFoundryHost('https://services.ai.azure.com@attacker.com/'),
    ).toBe(false);
  });

  it('accepts the configured env-var hosts exactly', () => {
    expect(
      isAllowedFoundryHost(
        'https://us.services.ai.azure.com/api/projects/default',
      ),
    ).toBe(true);
  });

  it('rejects malformed input gracefully', () => {
    expect(isAllowedFoundryHost('')).toBe(false);
    expect(isAllowedFoundryHost('not a url')).toBe(false);
    // @ts-expect-error - testing wrong type
    expect(isAllowedFoundryHost(null)).toBe(false);
    // @ts-expect-error
    expect(isAllowedFoundryHost(undefined)).toBe(false);
  });

  it('accepts the bare allow-listed apex (services.ai.azure.com)', () => {
    expect(isAllowedFoundryHost('https://services.ai.azure.com/')).toBe(true);
  });
});
