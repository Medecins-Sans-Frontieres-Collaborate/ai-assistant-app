import { parseRegion } from '@/lib/utils/shared/region';

import { describe, expect, it } from 'vitest';

describe('parseRegion', () => {
  it('accepts US/EU case-insensitively and trims whitespace', () => {
    expect(parseRegion('US')).toBe('US');
    expect(parseRegion('eu')).toBe('EU');
    expect(parseRegion('  Us  ')).toBe('US');
    expect(parseRegion('eU')).toBe('EU');
  });

  it('returns null for absent or unrecognized values', () => {
    expect(parseRegion(null)).toBeNull();
    expect(parseRegion(undefined)).toBeNull();
    expect(parseRegion('')).toBeNull();
    expect(parseRegion('APAC')).toBeNull();
    expect(parseRegion('clear')).toBeNull();
  });
});
