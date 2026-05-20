'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface DropdownPortalProps {
  children: React.ReactNode;
  triggerRef: React.RefObject<HTMLElement | null>;
  isOpen: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
}

/**
 * Portal component for rendering dropdowns outside their parent DOM hierarchy
 * This prevents z-index and overflow issues when dropdowns are inside scrolling containers
 */
export function DropdownPortal({
  children,
  triggerRef,
  isOpen,
  onClose,
  align = 'left',
}: DropdownPortalProps) {
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Calculate position based on trigger element
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      setPosition({
        top: triggerRect.bottom + 4, // 4px gap (mt-1)
        left: align === 'left' ? triggerRect.left : triggerRect.right,
        width: triggerRect.width,
      });
    }
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
