// @vitest-environment jsdom
// Reads elements and focus, so it needs a DOM although it lives with the
// server-side utility tests.
import {
  groupKeyTarget,
  isEditableTarget,
  ownsKeyboard,
} from '@/lib/utils/client/keyboardScope';

import { formatKeys } from '@/lib/constants/keyboardShortcuts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('groupKeyTarget', () => {
  it('moves one item with the arrows of its orientation', () => {
    expect(groupKeyTarget('ArrowDown', 1, 4, 'vertical')).toBe(2);
    expect(groupKeyTarget('ArrowUp', 1, 4, 'vertical')).toBe(0);
    expect(groupKeyTarget('ArrowRight', 1, 4, 'horizontal')).toBe(2);
    expect(groupKeyTarget('ArrowLeft', 1, 4, 'horizontal')).toBe(0);
  });

  it('ignores the arrows across its orientation', () => {
    expect(groupKeyTarget('ArrowRight', 1, 4, 'vertical')).toBeNull();
    expect(groupKeyTarget('ArrowDown', 1, 4, 'horizontal')).toBeNull();
  });

  it('takes all four arrows when laid out both ways', () => {
    expect(groupKeyTarget('ArrowRight', 1, 4, 'both')).toBe(2);
    expect(groupKeyTarget('ArrowDown', 1, 4, 'both')).toBe(2);
    expect(groupKeyTarget('ArrowLeft', 1, 4, 'both')).toBe(0);
  });

  it('stops at the ends rather than wrapping', () => {
    expect(groupKeyTarget('ArrowDown', 3, 4, 'vertical')).toBe(3);
    expect(groupKeyTarget('ArrowUp', 0, 4, 'vertical')).toBe(0);
  });

  it('goes to the first and last with Home and End', () => {
    expect(groupKeyTarget('Home', 2, 4, 'vertical')).toBe(0);
    expect(groupKeyTarget('End', 0, 4, 'vertical')).toBe(3);
  });

  it('swaps left and right right to left', () => {
    expect(groupKeyTarget('ArrowLeft', 1, 4, 'horizontal', true)).toBe(2);
    expect(groupKeyTarget('ArrowRight', 1, 4, 'horizontal', true)).toBe(0);
  });

  it('leaves other keys, and empty groups, alone', () => {
    expect(groupKeyTarget('Enter', 1, 4, 'both')).toBeNull();
    expect(groupKeyTarget('ArrowDown', 0, 0, 'both')).toBeNull();
  });
});

describe('isEditableTarget', () => {
  const input = (type: string) => {
    const element = document.createElement('input');
    element.type = type;
    return element;
  };

  it('is true where text is typed', () => {
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(input('text'))).toBe(true);
    expect(isEditableTarget(input('search'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isEditableTarget(editable)).toBe(true);
  });

  it('is false for controls that take no text, and for no target', () => {
    expect(isEditableTarget(input('checkbox'))).toBe(false);
    expect(isEditableTarget(input('color'))).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('ownsKeyboard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /** A shown screen with a button, and a button elsewhere in the app. */
  function mount() {
    const root = document.createElement('div');
    const inside = document.createElement('button');
    const outside = document.createElement('button');
    root.append(inside);
    document.body.append(root, outside);
    // jsdom lays nothing out: an element is "shown" when it has boxes.
    vi.spyOn(root, 'getClientRects').mockReturnValue([
      new DOMRect(0, 0, 10, 10),
    ] as unknown as DOMRectList);
    return { root, inside, outside };
  }

  it('is true with the keyboard inside the screen, or nowhere', () => {
    const { root, inside } = mount();
    inside.focus();
    expect(ownsKeyboard(root)).toBe(true);
    inside.blur();
    expect(document.activeElement).toBe(document.body);
    expect(ownsKeyboard(root)).toBe(true);
  });

  it('is false with the keyboard elsewhere in the app', () => {
    const { root, outside } = mount();
    outside.focus();
    expect(ownsKeyboard(root)).toBe(false);
  });

  it('is false for a screen that is not shown, or not there', () => {
    const { root } = mount();
    vi.mocked(root.getClientRects).mockReturnValue(
      [] as unknown as DOMRectList,
    );
    expect(ownsKeyboard(root)).toBe(false);
    expect(ownsKeyboard(null)).toBe(false);
  });
});

describe('formatKeys', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names Ctrl elsewhere and Cmd on macOS', () => {
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' });
    expect(formatKeys(['ctrl'], '0')).toBe('Ctrl+0');
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(formatKeys(['ctrl'], '+')).toBe('Cmd++');
  });

  it('names keys as the shortcut help does', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(formatKeys([], 'Escape')).toBe('Esc');
    expect(formatKeys(['ctrl', 'shift'], 'k')).toBe('Ctrl+Shift+K');
  });
});
