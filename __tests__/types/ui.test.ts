import {
  DEFAULT_UI_PREFERENCES,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  validateUIPreferences,
} from '@/types/ui';

import { describe, expect, it } from 'vitest';

describe('validateUIPreferences — sidebarWidth', () => {
  it('defaults when the cookie predates the field', () => {
    const prefs = validateUIPreferences({ showChatbar: true, theme: 'dark' });
    expect(prefs.sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(prefs.showChatbar).toBe(true);
  });

  it('keeps an in-range width', () => {
    expect(validateUIPreferences({ sidebarWidth: 320 }).sidebarWidth).toBe(320);
  });

  it('clamps out-of-range widths instead of breaking the layout', () => {
    expect(validateUIPreferences({ sidebarWidth: 10 }).sidebarWidth).toBe(
      SIDEBAR_MIN_WIDTH,
    );
    expect(validateUIPreferences({ sidebarWidth: 9999 }).sidebarWidth).toBe(
      SIDEBAR_MAX_WIDTH,
    );
  });

  it('rejects non-numeric widths', () => {
    expect(validateUIPreferences({ sidebarWidth: '300' }).sidebarWidth).toBe(
      SIDEBAR_DEFAULT_WIDTH,
    );
    expect(validateUIPreferences({ sidebarWidth: NaN }).sidebarWidth).toBe(
      SIDEBAR_DEFAULT_WIDTH,
    );
  });

  it('DEFAULT_UI_PREFERENCES carries the default width', () => {
    expect(DEFAULT_UI_PREFERENCES.sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('clampSidebarWidth', () => {
  it('rounds and clamps', () => {
    expect(clampSidebarWidth(300.4)).toBe(300);
    expect(clampSidebarWidth(-5)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});
