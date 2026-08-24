import { OC_NAMES, resolveOC } from '@/lib/services/grants/ocConfig';

import { describe, expect, it } from 'vitest';

/**
 * resolveOC is the single canonicalizer for OC identifiers. Every grants blob
 * path (grants/<oc>/...) is built from its output, on both the upload side and
 * the read/coverage side. Blob paths are case-sensitive, so if resolveOC ever
 * returned a different casing than the UI/storage convention, uploaded
 * allocation lists would become invisible to the coverage check — the exact
 * regression these tests guard against.
 */
describe('resolveOC', () => {
  it('returns the canonical display name for a known OC, regardless of input case', () => {
    expect(resolveOC('OCA')).toBe('OCA');
    expect(resolveOC('oca')).toBe('OCA');
    expect(resolveOC('oCa')).toBe('OCA');
  });

  it('preserves mixed-case canonical names (WaCA is not WACA or waca)', () => {
    expect(resolveOC('WaCA')).toBe('WaCA');
    expect(resolveOC('waca')).toBe('WaCA');
    expect(resolveOC('WACA')).toBe('WaCA');
  });

  it('resolves every OC the UI dropdown offers', () => {
    for (const name of ['OCA', 'OCB', 'OCBA', 'OCG', 'OCP', 'WaCA']) {
      expect(resolveOC(name)).toBe(name);
    }
  });

  it('rejects unknown or non-string OCs', () => {
    expect(resolveOC('nope')).toBeNull();
    expect(resolveOC('')).toBeNull();
    expect(resolveOC(undefined)).toBeNull();
    expect(resolveOC(null)).toBeNull();
    expect(resolveOC(42)).toBeNull();
  });

  it('is idempotent — resolving its own output is a fixed point', () => {
    for (const name of OC_NAMES) {
      expect(resolveOC(name)).toBe(name);
    }
  });

  it('OC_NAMES are the canonical display names, not the lowercase config keys', () => {
    expect(OC_NAMES).toContain('OCA');
    expect(OC_NAMES).toContain('WaCA');
    expect(OC_NAMES).not.toContain('oca');
  });
});
