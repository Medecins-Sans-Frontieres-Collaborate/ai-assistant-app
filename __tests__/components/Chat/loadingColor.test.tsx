import { getLoadingColorClasses } from '@/components/Chat/ChatMessages';

import { describe, expect, it } from 'vitest';

/**
 * The loading text's color wave drifts warmer as the wait grows: gray →
 * pale blue (10s) → yellow (25s) → orange (45s) → brown (75s). Long tool
 * round-trips (Bing grounding) are legitimate; the color acknowledges the
 * wait. Tiers are emitted as `--wave-color` custom-property classes; the
 * component swaps them at the shimmer's iteration boundary so every
 * change passes through gray.
 */
describe('getLoadingColorClasses', () => {
  it('starts gray (gray-400 wave)', () => {
    expect(getLoadingColorClasses(0)).toContain('[--wave-color:#9ca3af]');
    expect(getLoadingColorClasses(9)).toContain('[--wave-color:#9ca3af]');
  });

  it('shifts to pale blue (sky-400) at 10s', () => {
    expect(getLoadingColorClasses(10)).toContain('[--wave-color:#38bdf8]');
    expect(getLoadingColorClasses(24)).toContain('[--wave-color:#38bdf8]');
  });

  it('shifts to yellow (yellow-600) at 25s', () => {
    expect(getLoadingColorClasses(25)).toContain('[--wave-color:#ca8a04]');
    expect(getLoadingColorClasses(44)).toContain('[--wave-color:#ca8a04]');
  });

  it('shifts to orange (orange-500) at 45s', () => {
    expect(getLoadingColorClasses(45)).toContain('[--wave-color:#f97316]');
    expect(getLoadingColorClasses(74)).toContain('[--wave-color:#f97316]');
  });

  it('shifts to brown (amber-800) at 75s and stays there', () => {
    expect(getLoadingColorClasses(75)).toContain('[--wave-color:#92400e]');
    expect(getLoadingColorClasses(600)).toContain('[--wave-color:#92400e]');
  });

  it('every tier carries dark-mode variants', () => {
    for (const s of [0, 10, 25, 45, 75]) {
      expect(getLoadingColorClasses(s)).toMatch(/dark:\[--wave-color:/);
    }
  });

  describe('activity floor', () => {
    it('is blue immediately when a tool activity message shows', () => {
      expect(getLoadingColorClasses(0, true)).toContain(
        '[--wave-color:#38bdf8]',
      );
      expect(getLoadingColorClasses(9, true)).toContain(
        '[--wave-color:#38bdf8]',
      );
    });

    it('does not hold back the warmer tiers', () => {
      expect(getLoadingColorClasses(25, true)).toContain(
        '[--wave-color:#ca8a04]',
      );
      expect(getLoadingColorClasses(45, true)).toContain(
        '[--wave-color:#f97316]',
      );
      expect(getLoadingColorClasses(75, true)).toContain(
        '[--wave-color:#92400e]',
      );
    });

    it('default "Thinking…" (no activity) still starts gray', () => {
      expect(getLoadingColorClasses(0, false)).toContain(
        '[--wave-color:#9ca3af]',
      );
      expect(getLoadingColorClasses(0)).toContain('[--wave-color:#9ca3af]');
    });
  });
});
