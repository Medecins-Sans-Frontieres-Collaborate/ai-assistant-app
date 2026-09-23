'use client';

import { ReactNode, useCallback, useEffect, useRef } from 'react';

/** A small icon-only button, the drafter's unit of chrome. */
export const iconButton =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';

/** A menu row inside a popover. */
export const menuItem =
  'inline-flex min-h-[32px] w-full items-center gap-2 rounded-lg px-2 py-1 text-start text-sm text-gray-800 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-200 dark:hover:bg-surface-dark-elevated';

export type PopoverPlacement =
  | 'below-start'
  | 'below-end'
  | 'above-start'
  | 'above-end';

/**
 * A popover anchored to its parent element, closed by Escape, a press
 * outside, or the page scrolling. Everything the drafter shows on demand
 * (menus, pickers, the shortcuts list) uses this one, so they all behave the
 * same way.
 *
 * It is positioned FIXED from the parent's rectangle rather than absolutely
 * inside it: the drafter's bars and columns scroll, and an absolute popover
 * inside a scrolling box is clipped to it, which looks like nothing opened.
 */
export function Popover({
  open,
  onClose,
  children,
  placement = 'below-end',
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: PopoverPlacement;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Placed once, when it mounts: it closes on any scroll or resize, so the
  // anchor cannot move underneath it.
  const place = useCallback(
    (node: HTMLDivElement | null) => {
      ref.current = node;
      const anchor = node?.parentElement?.getBoundingClientRect();
      if (!node || !anchor) return;
      const gap = 4;
      const margin = 8;
      const rtl = getComputedStyle(node).direction === 'rtl';
      const above = placement.startsWith('above');
      // "end" is the right edge in LTR and the left edge in RTL.
      const alignRight = placement.endsWith('end') !== rtl;
      node.style.position = 'fixed';
      if (above) {
        node.style.bottom = `${window.innerHeight - anchor.top + gap}px`;
        node.style.maxHeight = `${anchor.top - gap - margin}px`;
      } else {
        node.style.top = `${anchor.bottom + gap}px`;
        node.style.maxHeight = `${window.innerHeight - anchor.bottom - gap - margin}px`;
      }
      if (alignRight) {
        node.style.right = `${Math.max(margin, window.innerWidth - anchor.right)}px`;
      } else {
        node.style.left = `${Math.max(margin, anchor.left)}px`;
      }
      node.style.maxWidth = `${window.innerWidth - 2 * margin}px`;
    },
    [placement],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Scrolling inside the popover is fine; the page moving under it is not.
    const onScroll = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={place}
      className={`z-40 min-w-[180px] overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 text-sm shadow-lg dark:border-gray-700 dark:bg-surface-dark ${className}`}
    >
      {children}
    </div>
  );
}
