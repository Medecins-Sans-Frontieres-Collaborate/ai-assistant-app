/**
 * @vitest-environment jsdom
 */
import type {
  KeyboardShortcut,
  ShortcutContextState,
} from '@/types/keyboardShortcuts';

import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_CATEGORY_ORDER,
  formatShortcut,
  getShortcutsByCategory,
  isContextSatisfied,
  matchesShortcut,
} from '@/lib/constants/keyboardShortcuts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Keyboard Shortcuts Utilities', () => {
  describe('matchesShortcut', () => {
    const createKeyboardEvent = (
      key: string,
      options: {
        ctrlKey?: boolean;
        shiftKey?: boolean;
        altKey?: boolean;
        metaKey?: boolean;
      } = {},
    ): KeyboardEvent => {
      return new KeyboardEvent('keydown', {
        key,
        ctrlKey: options.ctrlKey ?? false,
        shiftKey: options.shiftKey ?? false,
        altKey: options.altKey ?? false,
        metaKey: options.metaKey ?? false,
      });
    };

    it('matches simple key without modifiers', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'Escape',
        modifiers: [],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      const event = createKeyboardEvent('Escape');
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });

    it('matches key with Ctrl modifier', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: ',',
        modifiers: ['ctrl'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      const event = createKeyboardEvent(',', { ctrlKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });

    it('matches key with Ctrl+Shift modifiers', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'b',
        modifiers: ['ctrl', 'shift'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      const event = createKeyboardEvent('b', { ctrlKey: true, shiftKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });

    it('matches key with Meta key (macOS Cmd)', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'b',
        modifiers: ['ctrl', 'shift'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      // On macOS, Cmd key is metaKey
      const event = createKeyboardEvent('b', { metaKey: true, shiftKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });

    it('does not match when modifier is missing', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'b',
        modifiers: ['ctrl', 'shift'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      // Missing shift
      const event = createKeyboardEvent('b', { ctrlKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(false);
    });

    it('does not match when extra modifier is present', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'b',
        modifiers: ['ctrl'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      // Extra shift modifier
      const event = createKeyboardEvent('b', { ctrlKey: true, shiftKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(false);
    });

    it('matches case-insensitively for letters', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'B',
        modifiers: ['ctrl'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      const event = createKeyboardEvent('b', { ctrlKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });

    it('does not match different key', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'a',
        modifiers: ['ctrl'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      const event = createKeyboardEvent('b', { ctrlKey: true });
      expect(matchesShortcut(event, shortcut)).toBe(false);
    });

    it('matches slash key', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: '/',
        modifiers: [],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: true,
      };

      const event = createKeyboardEvent('/');
      expect(matchesShortcut(event, shortcut)).toBe(true);
    });
  });

  describe('isContextSatisfied', () => {
    const baseState: ShortcutContextState = {
      isStreaming: false,
      hasMessages: false,
      isModalOpen: false,
      isSidebarOpen: false,
    };

    it('returns true for "always" context', () => {
      expect(isContextSatisfied('always', baseState)).toBe(true);
      expect(
        isContextSatisfied('always', { ...baseState, isStreaming: true }),
      ).toBe(true);
    });

    it('returns true for "streaming" when isStreaming is true', () => {
      expect(
        isContextSatisfied('streaming', { ...baseState, isStreaming: true }),
      ).toBe(true);
      expect(isContextSatisfied('streaming', baseState)).toBe(false);
    });

    it('returns true for "notStreaming" when isStreaming is false', () => {
      expect(isContextSatisfied('notStreaming', baseState)).toBe(true);
      expect(
        isContextSatisfied('notStreaming', { ...baseState, isStreaming: true }),
      ).toBe(false);
    });

    it('returns true for "hasMessages" when hasMessages is true', () => {
      expect(
        isContextSatisfied('hasMessages', { ...baseState, hasMessages: true }),
      ).toBe(true);
      expect(isContextSatisfied('hasMessages', baseState)).toBe(false);
    });

    it('returns true for "modalOpen" when isModalOpen is true', () => {
      expect(
        isContextSatisfied('modalOpen', { ...baseState, isModalOpen: true }),
      ).toBe(true);
      expect(isContextSatisfied('modalOpen', baseState)).toBe(false);
    });
  });

  describe('formatShortcut', () => {
    beforeEach(() => {
      // Reset navigator.platform mock
      vi.stubGlobal('navigator', { platform: 'Win32' });
    });

    it('formats simple key without modifiers', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'Escape',
        modifiers: [],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      expect(formatShortcut(shortcut)).toBe('Esc');
    });

    it('formats Ctrl+key on Windows/Linux', () => {
      vi.stubGlobal('navigator', { platform: 'Win32' });

      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: ',',
        modifiers: ['ctrl'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      expect(formatShortcut(shortcut)).toBe('Ctrl+,');
    });

    it('formats Cmd+key on macOS', () => {
      vi.stubGlobal('navigator', { platform: 'MacIntel' });

      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: ',',
        modifiers: ['ctrl'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      expect(formatShortcut(shortcut)).toBe('Cmd+,');
    });

    it('formats Ctrl+Shift+key', () => {
      vi.stubGlobal('navigator', { platform: 'Win32' });

      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'b',
        modifiers: ['ctrl', 'shift'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      expect(formatShortcut(shortcut)).toBe('Ctrl+Shift+B');
    });

    it('formats Alt key', () => {
      vi.stubGlobal('navigator', { platform: 'Win32' });

      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'a',
        modifiers: ['alt'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      expect(formatShortcut(shortcut)).toBe('Alt+A');
    });

    it('formats Option key on macOS', () => {
      vi.stubGlobal('navigator', { platform: 'MacIntel' });

      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'a',
        modifiers: ['alt'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      expect(formatShortcut(shortcut)).toBe('Option+A');
    });

    it('formats slash key', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: '/',
        modifiers: [],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: true,
      };

      expect(formatShortcut(shortcut)).toBe('/');
    });

    it('formats End key', () => {
      const shortcut: KeyboardShortcut = {
        id: 'test',
        key: 'End',
        modifiers: ['ctrl'],
        labelKey: 'test.label',
        categoryKey: 'test.category',
        contextRequired: 'always',
        disableInInput: false,
      };

      expect(formatShortcut(shortcut)).toBe('Ctrl+End');
    });
  });

  describe('getShortcutsByCategory', () => {
    it('returns shortcuts grouped by category', () => {
      const grouped = getShortcutsByCategory();

      // Should have all categories
      expect(Object.keys(grouped).length).toBeGreaterThan(0);

      // Each category should have shortcuts
      for (const categoryKey of Object.keys(grouped)) {
        expect(grouped[categoryKey].length).toBeGreaterThan(0);
      }
    });

    it('all shortcuts are categorized', () => {
      const grouped = getShortcutsByCategory();
      const allGroupedShortcuts = Object.values(grouped).flat();

      expect(allGroupedShortcuts.length).toBe(
        Object.values(DEFAULT_SHORTCUTS).length,
      );
    });
  });

  describe('DEFAULT_SHORTCUTS', () => {
    it('has all expected shortcuts', () => {
      const expectedActions = [
        'focusChatInput',
        'newConversation',
        'stopGeneration',
        'toggleSidebar',
        'openSettings',
        'openModelSelector',
        'scrollToBottom',
        'showShortcutsHelp',
        'attachFile',
      ];

      for (const action of expectedActions) {
        expect(DEFAULT_SHORTCUTS).toHaveProperty(action);
      }
    });

    it('all shortcuts have required fields', () => {
      for (const shortcut of Object.values(DEFAULT_SHORTCUTS)) {
        expect(shortcut).toHaveProperty('id');
        expect(shortcut).toHaveProperty('key');
        expect(shortcut).toHaveProperty('modifiers');
        expect(shortcut).toHaveProperty('labelKey');
        expect(shortcut).toHaveProperty('categoryKey');
        expect(shortcut).toHaveProperty('contextRequired');
        expect(shortcut).toHaveProperty('disableInInput');
      }
    });

    it('shortcuts use safe key combinations', () => {
      // Verify no single-key shortcuts that would conflict with typing
      // (except for Escape and / which have context restrictions)
      for (const [action, shortcut] of Object.entries(DEFAULT_SHORTCUTS)) {
        if (shortcut.modifiers.length === 0) {
          // Single key shortcuts should be disableInInput or special keys
          expect(
            shortcut.disableInInput ||
              shortcut.key === 'Escape' ||
              shortcut.contextRequired === 'streaming',
          ).toBe(true);
        }
      }
    });
  });

  describe('SHORTCUT_CATEGORY_ORDER', () => {
    it('includes all category keys used in shortcuts', () => {
      const usedCategories = new Set(
        Object.values(DEFAULT_SHORTCUTS).map((s) => s.categoryKey),
      );

      for (const category of usedCategories) {
        expect(SHORTCUT_CATEGORY_ORDER).toContain(category);
      }
    });
  });
});
