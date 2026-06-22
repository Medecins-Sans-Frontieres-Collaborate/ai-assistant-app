import { getModifierLabel, isMacPlatform } from '@/lib/utils/shared/platform';

import { afterEach, describe, expect, it } from 'vitest';

const originalNavigator = globalThis.navigator;

function setNavigatorPlatform(platform: string | undefined) {
  if (platform === undefined) {
    // Simulate SSR — no navigator at all.
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    return;
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform },
    configurable: true,
    writable: true,
  });
}

describe('platform helper', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  describe('isMacPlatform', () => {
    it('returns false when navigator is undefined (SSR)', () => {
      setNavigatorPlatform(undefined);
      expect(isMacPlatform()).toBe(false);
    });

    it('returns true on MacIntel', () => {
      setNavigatorPlatform('MacIntel');
      expect(isMacPlatform()).toBe(true);
    });

    it('returns true on iPhone', () => {
      setNavigatorPlatform('iPhone');
      expect(isMacPlatform()).toBe(true);
    });

    it('returns true on iPad', () => {
      setNavigatorPlatform('iPad');
      expect(isMacPlatform()).toBe(true);
    });

    it('returns false on Win32', () => {
      setNavigatorPlatform('Win32');
      expect(isMacPlatform()).toBe(false);
    });

    it('returns false on Linux x86_64', () => {
      setNavigatorPlatform('Linux x86_64');
      expect(isMacPlatform()).toBe(false);
    });
  });

  describe('getModifierLabel', () => {
    it('returns "⌘" on Mac', () => {
      setNavigatorPlatform('MacIntel');
      expect(getModifierLabel()).toBe('⌘');
    });

    it('returns "Ctrl" on Windows', () => {
      setNavigatorPlatform('Win32');
      expect(getModifierLabel()).toBe('Ctrl');
    });

    it('defaults to "Ctrl" when navigator is undefined (SSR)', () => {
      setNavigatorPlatform(undefined);
      expect(getModifierLabel()).toBe('Ctrl');
    });

    it('returns a bare label with no trailing whitespace', () => {
      setNavigatorPlatform('Win32');
      const label = getModifierLabel();
      expect(label).toBe(label.trim());
    });
  });
});
