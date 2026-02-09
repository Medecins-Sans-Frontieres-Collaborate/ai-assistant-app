'use client';

import React, { useCallback, useRef, useState } from 'react';

import { Session } from 'next-auth';
import { useTranslations } from 'next-intl';

import { DisplayNamePopover } from './DisplayNamePopover';

interface EmptyStateProps {
  /** Display name to show in greeting */
  userName?: string;
  /** User session for display name picker */
  user?: Session['user'];
  /** Enable interactive hover/click to change display name (default: true if user is provided) */
  interactive?: boolean;
}

/**
 * Empty state header with greeting.
 * Displays a localized greeting message with optional user name.
 * When interactive, hovering or clicking the greeting shows a popover to change display name preference.
 */
export function EmptyState({ userName, user, interactive }: EmptyStateProps) {
  const t = useTranslations('emptyState');
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const greetingRef = useRef<HTMLSpanElement>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const leaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Determine if greeting should be interactive
  const isInteractive = interactive ?? !!user;

  const handleMouseEnter = useCallback(() => {
    if (!isInteractive) return;

    // Clear any pending leave timeout
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }

    // Delay before showing popover (200ms)
    hoverTimeoutRef.current = setTimeout(() => {
      setIsPopoverOpen(true);
    }, 200);
  }, [isInteractive]);

  const handleMouseLeave = useCallback(() => {
    if (!isInteractive) return;

    // Clear any pending hover timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }

    // Delay before closing popover (300ms) to allow moving to popover
    leaveTimeoutRef.current = setTimeout(() => {
      setIsPopoverOpen(false);
    }, 300);
  }, [isInteractive]);

  const handleClick = useCallback(() => {
    if (!isInteractive) return;

    // Clear any pending timeouts
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }

    // Toggle popover on click (for mobile/touch)
    setIsPopoverOpen((prev) => !prev);
  }, [isInteractive]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!isInteractive) return;

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setIsPopoverOpen((prev) => !prev);
      }
    },
    [isInteractive],
  );

  const handleClosePopover = useCallback(() => {
    setIsPopoverOpen(false);
  }, []);

  // Keep popover open when hovering over it
  const handlePopoverMouseEnter = useCallback(() => {
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }
  }, []);

  const greetingText = userName
    ? t('greetingWithName', { name: userName })
    : t('greeting');

  return (
    <div className="flex items-center justify-center">
      <h1 className="text-2xl font-light bg-gradient-to-r rtl:bg-gradient-to-l from-[#F73837] from-0% via-rose-500 via-15% to-rose-900 to-100% dark:from-[#F73837] dark:from-0% dark:via-[#FF8A89] dark:via-15% dark:to-gray-400 dark:to-100% bg-clip-text text-transparent">
        {isInteractive ? (
          <span
            ref={greetingRef}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            aria-expanded={isPopoverOpen}
            aria-label={t('changeDisplayName')}
            className="cursor-pointer transition-[filter,text-decoration] duration-200 hover:underline hover:brightness-110 underline-offset-4 decoration-rose-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#212121] rounded"
          >
            {greetingText}
          </span>
        ) : (
          greetingText
        )}
      </h1>

      {isInteractive && (
        <div
          onMouseEnter={handlePopoverMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <DisplayNamePopover
            isOpen={isPopoverOpen}
            onClose={handleClosePopover}
            triggerRef={greetingRef}
            user={user}
          />
        </div>
      )}
    </div>
  );
}
