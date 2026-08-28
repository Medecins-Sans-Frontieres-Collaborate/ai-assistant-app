import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import {
  DEFAULT_UI_PREFERENCES,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '@/types/ui';

import { UIPreferencesProvider } from '@/components/Providers/UIPreferencesProvider';
import { SidebarResizeHandle } from '@/components/Sidebar/components/SidebarResizeHandle';

import '@testing-library/jest-dom';
import { afterEach, describe, expect, it } from 'vitest';

function renderHandle(width = SIDEBAR_DEFAULT_WIDTH) {
  return render(
    <UIPreferencesProvider
      initialPreferences={{
        ...DEFAULT_UI_PREFERENCES,
        showChatbar: true,
        sidebarWidth: width,
      }}
    >
      <div data-sidebar-width-root data-testid="root">
        <SidebarResizeHandle />
      </div>
    </UIPreferencesProvider>,
  );
}

const handle = () => screen.getByRole('separator');

describe('SidebarResizeHandle', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-sidebar-resizing');
  });

  it('exposes the width as a vertical separator with bounds', () => {
    renderHandle(300);
    const el = handle();
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    expect(el).toHaveAttribute('aria-valuenow', '300');
    expect(el).toHaveAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH));
    expect(el).toHaveAttribute('aria-valuemax', String(SIDEBAR_MAX_WIDTH));
  });

  it('nudges with arrow keys, clamps at the bounds, and resets on Home', () => {
    renderHandle();
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(handle()).toHaveAttribute('aria-valuenow', '276');
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(handle()).toHaveAttribute('aria-valuenow', '244');
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(handle()).toHaveAttribute(
      'aria-valuenow',
      String(SIDEBAR_DEFAULT_WIDTH),
    );

    for (let i = 0; i < 40; i++)
      fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(handle()).toHaveAttribute(
      'aria-valuenow',
      String(SIDEBAR_MAX_WIDTH),
    );
  });

  it('drags: live-updates the CSS variable on the root, then commits on release', () => {
    renderHandle();
    const root = screen.getByTestId('root');

    fireEvent.pointerDown(handle(), { button: 0, clientX: 100, pointerId: 1 });
    expect(document.documentElement).toHaveAttribute('data-sidebar-resizing');

    fireEvent.pointerMove(handle(), { clientX: 180, pointerId: 1 });
    expect(root.style.getPropertyValue('--sidebar-width')).toBe('340px');
    expect(handle()).toHaveAttribute('aria-valuenow', '340');

    // Past the max: clamped.
    fireEvent.pointerMove(handle(), { clientX: 1000, pointerId: 1 });
    expect(root.style.getPropertyValue('--sidebar-width')).toBe(
      `${SIDEBAR_MAX_WIDTH}px`,
    );

    fireEvent.pointerUp(handle(), { pointerId: 1 });
    expect(document.documentElement).not.toHaveAttribute(
      'data-sidebar-resizing',
    );
    expect(handle()).toHaveAttribute(
      'aria-valuenow',
      String(SIDEBAR_MAX_WIDTH),
    );
  });

  it('double-click resets to the default width', () => {
    renderHandle(400);
    fireEvent.doubleClick(handle());
    expect(handle()).toHaveAttribute(
      'aria-valuenow',
      String(SIDEBAR_DEFAULT_WIDTH),
    );
  });
});
