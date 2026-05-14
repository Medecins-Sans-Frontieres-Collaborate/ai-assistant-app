import { render, screen } from '@testing-library/react';
import React, { useRef } from 'react';

import { DropdownPortal } from '@/components/UI/DropdownPortal';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const VIEWPORT_HEIGHT = 800;
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

// The portal's outer wrapper is the parent of the rendered menu children.
// Walking up from a test-id avoids coupling tests to the wrapper's class name
// or z-index.
function getPortalElement(): HTMLElement {
  const menu = screen.getByTestId('menu');
  const portal = menu.parentElement;
  if (!portal) throw new Error('Portal element not found');
  return portal;
}

describe('DropdownPortal placement', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: VIEWPORT_HEIGHT,
    });

    // Patch only the portal wrapper's rect — child of a fixed-position element
    // is the menu we render in the harness, so we can identify the wrapper as
    // any element that *contains* an element with `data-testid="menu"`.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        const hasMenuChild =
          this instanceof HTMLElement &&
          this.querySelector?.('[data-testid="menu"]') !== null;
        if (hasMenuChild) {
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
