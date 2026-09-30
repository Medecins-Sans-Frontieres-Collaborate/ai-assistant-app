import { fireEvent, render, screen } from '@testing-library/react';

import { Popover } from '@/components/Workflows/Shared/Drafter/Popover';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

describe('Popover', () => {
  it('floats over the page from its anchor, so a scrolling box cannot clip it', () => {
    render(
      <div style={{ overflow: 'auto', width: 40 }}>
        <span>
          <button type="button">anchor</button>
          <Popover open onClose={vi.fn()} placement="below-end">
            <p>content</p>
          </Popover>
        </span>
      </div>,
    );
    const panel = screen.getByText('content').parentElement as HTMLElement;
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.top).not.toBe('');
    expect(panel.style.right).not.toBe('');
    expect(panel.style.maxHeight).not.toBe('');
  });

  it('closes on Escape, on a press outside, and when the page scrolls', () => {
    const onClose = vi.fn();
    render(
      <span>
        <Popover open onClose={onClose}>
          <p>content</p>
        </Popover>
      </span>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.body);
    fireEvent.scroll(document);
    expect(onClose).toHaveBeenCalledTimes(3);
    // Scrolling inside the popover itself is not a reason to close.
    fireEvent.scroll(screen.getByText('content'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
