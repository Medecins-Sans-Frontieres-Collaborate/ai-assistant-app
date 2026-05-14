'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface DropdownPortalProps {
  children: React.ReactNode;
  triggerRef: React.RefObject<HTMLElement | null>;
  isOpen: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
}

type Placement = 'bottom' | 'top';

interface PortalPosition {
  top: number;
  left: number;
  width: number;
  placement: Placement;
}

const VIEWPORT_INSET_PX = 8;
const TRIGGER_GAP_PX = 4;

// useLayoutEffect logs a warning on the server. Fall back to useEffect when
// there is no DOM (SSR pass); the portal renders nothing then anyway.
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Portal component for rendering dropdowns outside their parent DOM hierarchy.
 * This prevents z-index and overflow issues when dropdowns are inside scrolling
 * containers. The portal places itself below the trigger by default and flips
 * above the trigger when there isn't room below, so menus near the viewport
 * edge stay fully reachable.
 */
export function DropdownPortal({
  children,
  triggerRef,
  isOpen,
  onClose,
  align = 'left',
}: DropdownPortalProps) {
  const [position, setPosition] = useState<PortalPosition>({
    top: 0,
    left: 0,
    width: 0,
    placement: 'bottom',
  });
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Measure trigger + menu and choose placement after the menu mounts so we
  // know the real menu height. useLayoutEffect runs synchronously before paint,
  // so the corrected position is committed without a one-frame flicker at the
  // previous open's stale coordinates.
  useIsomorphicLayoutEffect(() => {
    if (!isOpen) return;
    if (!triggerRef.current || !dropdownRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuRect = dropdownRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    const spaceBelow = viewportHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    const placement: Placement =
      menuRect.height + TRIGGER_GAP_PX > spaceBelow && spaceAbove > spaceBelow
        ? 'top'
        : 'bottom';

    const rawTop =
      placement === 'bottom'
        ? triggerRect.bottom + TRIGGER_GAP_PX
        : triggerRect.top - menuRect.height - TRIGGER_GAP_PX;

    const maxTop = Math.max(
      VIEWPORT_INSET_PX,
      viewportHeight - menuRect.height - VIEWPORT_INSET_PX,
    );
    const top = Math.min(Math.max(rawTop, VIEWPORT_INSET_PX), maxTop);

    let left = align === 'left' ? triggerRect.left : triggerRect.right;

    if (align === 'right' && left - menuRect.width < VIEWPORT_INSET_PX) {
      left = Math.min(
        menuRect.width + VIEWPORT_INSET_PX,
        viewportWidth - VIEWPORT_INSET_PX,
      );
    } else if (
      align === 'left' &&
      left + menuRect.width > viewportWidth - VIEWPORT_INSET_PX
    ) {
      left = Math.max(
        VIEWPORT_INSET_PX,
        viewportWidth - menuRect.width - VIEWPORT_INSET_PX,
      );
    }

    setPosition({ top, left, width: triggerRect.width, placement });
  }, [isOpen, triggerRef, align]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    // Add small delay to prevent immediate closing from the same click that opened it
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose, triggerRef]);

  // Close on scroll
  useEffect(() => {
    if (!isOpen) return;

    const handleScroll = () => {
      onClose();
    };

    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={dropdownRef}
      data-placement={position.placement}
      className="fixed z-[100]"
      style={{
        top: `${position.top}px`,
        left: align === 'left' ? `${position.left}px` : undefined,
        right:
          align === 'right'
            ? `${window.innerWidth - position.left}px`
            : undefined,
        width: `${position.width}px`,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
