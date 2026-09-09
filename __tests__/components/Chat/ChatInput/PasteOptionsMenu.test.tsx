/**
 * @vitest-environment jsdom
 *
 * Translations resolve to raw key names via the global next-intl mock.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';

import { PasteOption } from '@/client/services/paste/pasteOptions';

import { PasteOptionsMenu } from '@/components/Chat/ChatInput/PasteOptionsMenu';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ALL_OPTIONS: PasteOption[] = [
  { id: 'text', section: 'insert' },
  { id: 'markdown', section: 'insert' },
  { id: 'attachText', section: 'attach' },
  { id: 'image', section: 'attach', count: 2 },
];

describe('PasteOptionsMenu', () => {
  let textarea: HTMLTextAreaElement;
  let onSelect: ReturnType<typeof vi.fn>;
  let onDismiss: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    onSelect = vi.fn();
    onDismiss = vi.fn();
  });

  function renderMenu(options: PasteOption[] | null = ALL_OPTIONS) {
    return render(
      <PasteOptionsMenu
        options={options}
        textareaRef={{ current: textarea }}
        onSelect={onSelect}
        onDismiss={onDismiss}
      />,
    );
  }

  function items(): HTMLButtonElement[] {
    return screen.getAllByRole('menuitem') as HTMLButtonElement[];
  }

  it('renders nothing when closed', () => {
    renderMenu(null);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders only the given options, grouped by section, with accelerators', () => {
    renderMenu();
    const buttons = items();
    expect(buttons.map((b) => b.dataset.pasteOption)).toEqual([
      'text',
      'markdown',
      'attachText',
      'image',
    ]);
    expect(buttons.map((b) => b.querySelector('kbd')?.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(screen.getAllByRole('group')).toHaveLength(2);
    expect(screen.queryByText('link')).toBeNull();
  });

  it('focuses the first item on open', () => {
    renderMenu();
    expect(document.activeElement).toBe(items()[0]);
  });

  it('moves focus with arrow keys, wrapping at both ends', () => {
    renderMenu();
    const menu = screen.getByRole('menu');
    const buttons = items();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(buttons[3]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(buttons[3]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('keeps Tab inside the menu', () => {
    renderMenu();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(document.activeElement).toBe(items()[1]);
    fireEvent.keyDown(menu, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('selects the focused item on click and the numbered item on a digit', () => {
    renderMenu();
    fireEvent.click(items()[2]);
    expect(onSelect).toHaveBeenCalledWith('attachText');

    fireEvent.keyDown(screen.getByRole('menu'), { key: '4' });
    expect(onSelect).toHaveBeenLastCalledWith('image');
  });

  it('ignores a digit beyond the option count', () => {
    renderMenu();
    fireEvent.keyDown(screen.getByRole('menu'), { key: '9' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('dismisses on Escape', () => {
    renderMenu();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the composer when it closes', () => {
    const { rerender } = renderMenu();
    expect(document.activeElement).not.toBe(textarea);
    act(() => {
      rerender(
        <PasteOptionsMenu
          options={null}
          textareaRef={{ current: textarea }}
          onSelect={onSelect}
          onDismiss={onDismiss}
        />,
      );
    });
    expect(document.activeElement).toBe(textarea);
  });
});
