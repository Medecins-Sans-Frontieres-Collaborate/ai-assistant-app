import { render } from '@testing-library/react';
import React, { useRef } from 'react';

import { DropdownPortal } from '@/components/UI/DropdownPortal';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VIEWPORT_HEIGHT = 800;
const VIEWPORT_WIDTH = 1200;
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
}

function Harness({ triggerRect, align = 'left', isOpen = true }: HarnessProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        data-testid="trigger"
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
        onClose={() => {}}
        align={align}
      >
        <div data-testid="menu">menu content</div>
      </DropdownPortal>
    </>
  );
}

function getPortalElement(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('div.fixed.z-\\[100\\]');
  if (!el) throw new Error('Portal element not found');
  return el;
}

describe('DropdownPortal placement', () => {
  let originalRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: VIEWPORT_HEIGHT,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: VIEWPORT_WIDTH,
    });

    originalRect = Element.prototype.getBoundingClientRect;
    // Patch the portal element (class "fixed z-[100]") so it reports a known
    // menu height. Individual elements with their own getBoundingClientRect
    // overrides (the trigger) keep their per-instance behavior.
    Element.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.classList.contains('fixed')) {
        return makeRect({
          top: 0,
          bottom: MENU_HEIGHT,
          left: 0,
          right: MENU_WIDTH,
          width: MENU_WIDTH,
          height: MENU_HEIGHT,
        });
      }
      return originalRect.call(this);
    };
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect;
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

    const portal = getPortalElement();
    // spaceBelow = 800 - 120 = 680; menuHeight+4 = 204 ≤ 680 → bottom placement
    // top = triggerBottom + 4 = 124
    expect(portal.style.top).toBe('124px');
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

    const portal = getPortalElement();
    // spaceBelow = 800 - 720 = 80; menuHeight+4 = 204 > 80
    // spaceAbove = 700 > 80 → top placement
    // top = triggerTop - menuHeight - 4 = 700 - 200 - 4 = 496
    expect(portal.style.top).toBe('496px');
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

    const portal = getPortalElement();
    const top = parseFloat(portal.style.top);
    // Clamp: [8, max(8, 150 - 200 - 8)] → [8, max(8, -58)] → [8, 8]
    // Whatever the placement chose, it must be clamped to ≥ 8.
    expect(top).toBeGreaterThanOrEqual(8);
  });

  it('does not render when isOpen is false', () => {
    render(
      <Harness
        triggerRect={makeRect({ top: 0, bottom: 20, width: 20, height: 20 })}
        isOpen={false}
      />,
    );

    expect(document.body.querySelector('div.fixed.z-\\[100\\]')).toBeNull();
  });

  it('calls onClose when the window is resized', () => {
    const onClose = vi.fn();
    const triggerRef = React.createRef<HTMLButtonElement>();

    render(
      <>
        <button data-testid="trigger" ref={triggerRef}>
          trigger
        </button>
        <DropdownPortal triggerRef={triggerRef} isOpen={true} onClose={onClose}>
          <div>menu</div>
        </DropdownPortal>
      </>,
    );

    window.dispatchEvent(new Event('resize'));
    expect(onClose).toHaveBeenCalled();
  });
});
