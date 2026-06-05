import {
  isValidAccountName,
  isValidFoundryResourcePath,
  isValidResourceGroup,
  isValidSubscriptionId,
} from '@/lib/utils/shared/armPath';

import { describe, expect, it } from 'vitest';

describe('isValidFoundryResourcePath', () => {
  it('accepts a well-formed path with project', () => {
    expect(
      isValidFoundryResourcePath(
        '/subscriptions/abc-123/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-acct/projects/default',
      ),
    ).toBe(true);
  });

  it('accepts a path without the optional /projects segment', () => {
    expect(
      isValidFoundryResourcePath(
        '/subscriptions/abc-123/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-acct',
      ),
    ).toBe(true);
  });

  it('rejects paths with .. traversal', () => {
    expect(
      isValidFoundryResourcePath(
        '/subscriptions/../../etc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/x',
      ),
    ).toBe(false);
  });

  it('rejects double-slash paths', () => {
    expect(
      isValidFoundryResourcePath(
        '/subscriptions//resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/x',
      ),
    ).toBe(false);
  });

  it('rejects wrong provider', () => {
    expect(
      isValidFoundryResourcePath(
        '/subscriptions/x/resourceGroups/rg/providers/Microsoft.Storage/accounts/x',
      ),
    ).toBe(false);
  });

  it('rejects wrong resource type', () => {
    expect(
      isValidFoundryResourcePath(
        '/subscriptions/x/resourceGroups/rg/providers/Microsoft.CognitiveServices/something/x',
      ),
    ).toBe(false);
  });

  it('rejects extra trailing segments (anchor enforced)', () => {
    expect(
      isValidFoundryResourcePath(
        '/subscriptions/x/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/a/projects/p/extra/garbage',
      ),
    ).toBe(false);
  });

  it('rejects non-string inputs gracefully', () => {
    // @ts-expect-error - intentionally testing wrong type
    expect(isValidFoundryResourcePath(null)).toBe(false);
    // @ts-expect-error
    expect(isValidFoundryResourcePath(undefined)).toBe(false);
    // @ts-expect-error
    expect(isValidFoundryResourcePath(42)).toBe(false);
  });

  it('rejects overlong paths', () => {
    const long =
      '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/' +
      'a'.repeat(600);
    expect(isValidFoundryResourcePath(long)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidFoundryResourcePath('')).toBe(false);
  });
});

describe('isValidSubscriptionId / ResourceGroup / AccountName', () => {
  it('accepts typical Azure subscription GUIDs', () => {
    expect(isValidSubscriptionId('e49ac66c-c18d-4586-b132-8f201de8f2c2')).toBe(
      true,
    );
  });

  it('rejects path-injection attempts', () => {
    expect(isValidSubscriptionId('foo/bar')).toBe(false);
    expect(isValidSubscriptionId('foo bar')).toBe(false);
    expect(isValidResourceGroup('rg/with/slashes')).toBe(false);
    expect(isValidAccountName('a/b')).toBe(false);
  });

  it('accepts Azure-legal characters', () => {
    expect(isValidResourceGroup('rg.with.dots-and_underscores(parens)')).toBe(
      true,
    );
    expect(isValidAccountName('my-account-1')).toBe(true);
  });

  it('rejects too-short / too-long values', () => {
    expect(isValidAccountName('a')).toBe(false); // min 2
    expect(isValidAccountName('x'.repeat(65))).toBe(false); // max 64
  });
});
