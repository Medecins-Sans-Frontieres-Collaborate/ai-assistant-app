import { getLoadingColorClasses } from '@/components/Chat/ChatMessages';

import { describe, expect, it } from 'vitest';

/**
 * The loading shimmer drifts warmer as the wait grows: gray → pale blue
 * (10s) → pale yellow (25s) → pale orange (45s) → brown (75s). Long tool
 * round-trips (Bing grounding) are legitimate; the color acknowledges the
 * wait.
 */
describe('getLoadingColorClasses', () => {
  it('starts gray', () => {
    expect(getLoadingColorClasses(0)).toContain('from-gray-500');
    expect(getLoadingColorClasses(9)).toContain('from-gray-500');
  });

  it('shifts to pale blue at 10s', () => {
    expect(getLoadingColorClasses(10)).toContain('from-sky-400');
    expect(getLoadingColorClasses(24)).toContain('from-sky-400');
  });

  it('shifts to pale yellow at 25s', () => {
    expect(getLoadingColorClasses(25)).toContain('from-yellow-600');
    expect(getLoadingColorClasses(44)).toContain('from-yellow-600');
  });

  it('shifts to pale orange at 45s', () => {
    expect(getLoadingColorClasses(45)).toContain('from-orange-500');
    expect(getLoadingColorClasses(74)).toContain('from-orange-500');
  });

  it('shifts to brown at 75s and stays there', () => {
    expect(getLoadingColorClasses(75)).toContain('from-amber-800');
    expect(getLoadingColorClasses(600)).toContain('from-amber-800');
  });

  it('every tier carries dark-mode variants', () => {
    for (const s of [0, 10, 25, 45, 75]) {
      expect(getLoadingColorClasses(s)).toMatch(/dark:from-/);
    }
  });

  describe('activity floor', () => {
    it('is blue immediately when a tool activity message shows', () => {
      expect(getLoadingColorClasses(0, true)).toContain('from-sky-400');
      expect(getLoadingColorClasses(9, true)).toContain('from-sky-400');
    });

    it('does not hold back the warmer tiers', () => {
      expect(getLoadingColorClasses(25, true)).toContain('from-yellow-600');
      expect(getLoadingColorClasses(45, true)).toContain('from-orange-500');
      expect(getLoadingColorClasses(75, true)).toContain('from-amber-800');
    });

    it('default "Thinking…" (no activity) still starts gray', () => {
      expect(getLoadingColorClasses(0, false)).toContain('from-gray-500');
      expect(getLoadingColorClasses(0)).toContain('from-gray-500');
    });
  });
});
