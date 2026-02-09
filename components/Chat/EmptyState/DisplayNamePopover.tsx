'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { Session } from 'next-auth';

import { DisplayNamePreferencePicker } from '@/components/Settings/DisplayNamePreferencePicker';

interface DisplayNamePopoverProps {
  /** Whether the popover is currently open */
  isOpen: boolean;
  /** Callback to close the popover */
  onClose: () => void;
  /** Reference to the trigger element for positioning */
  triggerRef: React.RefObject<HTMLElement | null>;
  /** User session for the picker */
  user?: Session['user'];
}

// Subscribe function for useSyncExternalStore (no-op since we only need to know if mounted)
const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Portal-based popover for changing display name preference.
 * Appears below the greeting text and allows users to quickly change their name preference.
 * Supports both hover (desktop) and click/tap (mobile) interactions.
 */
export function DisplayNamePopover({
  isOpen,
  onClose,
  triggerRef,
  user,
}: DisplayNamePopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  // Use useSyncExternalStore to detect client-side rendering without triggering cascading renders
  const isMounted = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  // Calculate position based on trigger element
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const popoverWidth = 280; // Approximate width of popover

      // Calculate centered position below the trigger
      let left = triggerRect.left + triggerRect.width / 2 - popoverWidth / 2;

      // Ensure popover stays within viewport
      const padding = 16;
      if (left < padding) {
        left = padding;
      } else if (left + popoverWidth > window.innerWidth - padding) {
        left = window.innerWidth - popoverWidth - padding;
      }

      setPosition({
        top: triggerRect.bottom + 8, // 8px gap below trigger
        left,
      });
    }
  }, [isOpen, triggerRef]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
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

  // Close on ESC key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Close on scroll (optional - can be removed if users find it annoying)
  useEffect(() => {
    if (!isOpen) return;

    const handleScroll = () => {
      onClose();
    };

    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, [isOpen, onClose]);

  if (!isMounted || !isOpen) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-[200] w-[280px] p-3 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 animate-in fade-in slide-in-from-top-2 duration-200"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Change display name preference"
    >
      <DisplayNamePreferencePicker
        variant="popover"
        user={user}
        showPreview={true}
        showHelpText={false}
        onClose={onClose}
      />
    </div>,
    document.body,
  );
}
