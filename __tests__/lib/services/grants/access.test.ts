import { canAccessGrants } from '@/lib/services/grants/access';

import { describe, expect, it } from 'vitest';

const GROUP = 'AAAAAAAA-0000-0000-0000-000000000001';

describe('canAccessGrants', () => {
  it('grants members of the grants group, ignoring id case', () => {
    expect(
      canAccessGrants(['other', 'aaaaaaaa-0000-0000-0000-000000000001'], GROUP),
    ).toBe(true);
  });

  it('denies everyone else', () => {
    expect(canAccessGrants(['other'], GROUP)).toBe(false);
    expect(canAccessGrants([], GROUP)).toBe(false);
    expect(canAccessGrants(null, GROUP)).toBe(false);
    expect(canAccessGrants(undefined, GROUP)).toBe(false);
  });

  it('fails closed while no group id is configured', () => {
    expect(canAccessGrants(['anything'], '')).toBe(false);
    expect(canAccessGrants(['anything'], '   ')).toBe(false);
  });
});
