import { render, screen } from '@testing-library/react';
import React, { useRef } from 'react';

import { DropdownPortal } from '@/components/UI/DropdownPortal';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const VIEWPORT_HEIGHT = 800;
const VIEWPORT_WIDTH = 1024;
const MENU_HEIGHT = 200;
const MENU_WIDTH = 160;

function makeRect(rect: Partial<DOMRect>): DOMRect {
  return {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON() {
      return rect;
    },
    ...rect,
  } as DOMRect;
}

interface HarnessProps {
  triggerRect: DOMRect;
  align?: 'left' | 'right';
  isOpen?: boolean;
  onClose?: () => void;
}

function Harness({
  triggerRect,
  align = 'left',
  isOpen = true,
  onClose = () => {},
}: HarnessProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={(el) => {
          triggerRef.current = el;
          if (el) {
            el.getBoundingClientRect = () => triggerRect;
          }
        }}
      >
        trigger
      </button>
      <DropdownPortal
        triggerRef={triggerRef}
        isOpen={isOpen}
        onClose={onClose}
        align={align}
      >
        <div data-testid="menu">menu content</div>
      </DropdownPortal>
    </>
  );
}

// The portal's outer wrapper is marked with `data-dropdown-portal` so tests
// can find it without coupling to className or relying on parentElement walks.
function getPortalElement(): HTMLElement {
  const portal = document.querySelector<HTMLElement>('[data-dropdown-portal]');
  if (!portal) throw new Error('Portal element not found');
  return portal;
}

describe('DropdownPortal placement', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: VIEWPORT_HEIGHT,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: VIEWPORT_WIDTH,
    });

    // Patch only the portal wrapper's rect, identified by the
    // `data-dropdown-portal` marker the component sets on its outer div.
    // Other elements (body, harness wrappers) fall through to a zero rect so
    // their measurements don't accidentally satisfy the menu's expected size.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        if (
          this instanceof HTMLElement &&
          this.hasAttribute('data-dropdown-portal')
        ) {
          return makeRect({
            top: 0,
            bottom: MENU_HEIGHT,
            left: 0,
            right: MENU_WIDTH,
            width: MENU_WIDTH,
            height: MENU_HEIGHT,
          });
        }
        return makeRect({});
      },
    );
  });

  it('places the menu below the trigger when there is room', () => {
    render(
      <Harness
        triggerRect={makeRect({
          top: 100,
          bottom: 120,
          left: 100,
          right: 120,
          width: 20,
          height: 20,
        })}
      />,
    );

    // spaceBelow = 800 - 120 = 680; menuHeight+4 = 204 ≤ 680 → bottom placement
    // top = triggerBottom + 4 = 124
    expect(getPortalElement().style.top).toBe('124px');
  });

  it('flips above the trigger when there is not enough room below', () => {
    render(
      <Harness
        triggerRect={makeRect({
          top: 700,
          bottom: 720,
          left: 100,
          right: 120,
          width: 20,
          height: 20,
        })}
      />,
    );

    // spaceBelow = 800 - 720 = 80; menuHeight+4 = 204 > 80
    // spaceAbove = 700 > 80 → top placement
    // top = triggerTop - menuHeight - 4 = 700 - 200 - 4 = 496
    expect(getPortalElement().style.top).toBe('496px');
  });

  it('clamps top to keep the menu inside the viewport on very short screens', () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 150, // shorter than the menu height
    });

    render(
      <Harness
        triggerRect={makeRect({
          top: 80,
          bottom: 100,
          left: 100,
          right: 120,
          width: 20,
          height: 20,
        })}
      />,
    );

    // Clamp: [8, max(8, 150 - 200 - 8)] → [8, 8]. Top must be ≥ 8 regardless.
    expect(parseFloat(getPortalElement().style.top)).toBeGreaterThanOrEqual(8);
  });

  it('does not render when isOpen is false', () => {
    render(
      <Harness
        triggerRect={makeRect({ top: 0, bottom: 20, width: 20, height: 20 })}
        isOpen={false}
      />,
    );

    expect(screen.queryByTestId('menu')).toBeNull();
  });

  it('left-align: anchors the menu at the trigger left when there is room', () => {
    render(
      <Harness
        align="left"
        triggerRect={makeRect({
          top: 100,
          bottom: 120,
          left: 200,
          right: 220,
          width: 20,
          height: 20,
        })}
      />,
    );

    // anchorX = triggerRect.left = 200; menu doesn't clip the right edge
    // (200 + 160 = 360 < 1024 - 8 = 1016) so no adjustment.
    expect(getPortalElement().style.left).toBe('200px');
    expect(getPortalElement().style.right).toBe('');
  });

  it('left-align: pulls the menu in when its right edge would clip the viewport', () => {
    render(
      <Harness
        align="left"
        triggerRect={makeRect({
          // trigger.left = 950 → 950 + 160 = 1110 > 1024 - 8 = 1016, clips right
          top: 100,
          bottom: 120,
          left: 950,
          right: 970,
          width: 20,
          height: 20,
        })}
      />,
    );

    // anchorX is adjusted to viewportWidth - menuWidth - inset = 1024-160-8 = 856
    expect(getPortalElement().style.left).toBe('856px');
  });

  it('right-align: anchors the menu at the trigger right when there is room', () => {
    render(
      <Harness
        align="right"
        triggerRect={makeRect({
          top: 100,
          bottom: 120,
          left: 800,
          right: 820,
          width: 20,
          height: 20,
        })}
      />,
    );

    // anchorX = triggerRect.right = 820; left edge = 820 - 160 = 660 > 8, no adjust.
    // right css = window.innerWidth - anchorX = 1024 - 820 = 204
    expect(getPortalElement().style.right).toBe('204px');
    expect(getPortalElement().style.left).toBe('');
  });

  it('right-align: slides the menu right when its left edge would clip the viewport', () => {
    render(
      <Harness
        align="right"
        triggerRect={makeRect({
          // trigger.right = 100; left edge of menu = 100 - 160 = -60 < 8, clips left.
          top: 100,
          bottom: 120,
          left: 80,
          right: 100,
          width: 20,
          height: 20,
        })}
      />,
    );

    // anchorX adjusted to menuWidth + inset = 160 + 8 = 168
    // right css = 1024 - 168 = 856
    expect(getPortalElement().style.right).toBe('856px');
  });

  it('calls onClose when the window is resized', () => {
    const onClose = vi.fn();
    render(
      <Harness
        triggerRect={makeRect({
          top: 100,
          bottom: 120,
          width: 20,
          height: 20,
        })}
        onClose={onClose}
      />,
    );

    window.dispatchEvent(new Event('resize'));
    expect(onClose).toHaveBeenCalled();
  });
});
