'use client';

import { IconX } from '@tabler/icons-react';
import React from 'react';

/**
 * One capability bubble in the row above the composer: an icon-only pill
 * that grows a text label on hover or keyboard focus, with an optional
 * remove control that appears alongside. Every composer capability (skills,
 * the attached agent, active connectors) shares this shape, so attached
 * capabilities read as one row of small bubbles aligned to the pill's left
 * edge instead of a bar of text.
 *
 * Accessibility: the label is always in the DOM (clipped, never hidden),
 * the main button carries an explicit accessible name, and the remove
 * button stays focusable at zero width, so keyboard users reach it through
 * the group's focus-within expansion.
 */
export interface CapabilityBubbleProps {
  icon: React.ReactNode;
  /** Text revealed on hover/focus; also the accessible name unless `ariaLabel` is given. */
  label: string;
  ariaLabel?: string;
  /** Tooltip with detail beyond the label (semantics, state). */
  title?: string;
  onClick?: () => void;
  ariaExpanded?: boolean;
  /** Secondary action shown in the expanded state (detach / remove). */
  onRemove?: () => void;
  removeLabel?: string;
  /** Muted chrome for a capability that is present but inert (paused, stale). */
  muted?: boolean;
}

export const CapabilityBubble: React.FC<CapabilityBubbleProps> = ({
  icon,
  label,
  ariaLabel,
  title,
  onClick,
  ariaExpanded,
  onRemove,
  removeLabel,
  muted = false,
}) => (
  <span
    className={`group inline-flex h-7 items-center rounded-full border text-xs font-medium shadow-sm transition-colors ${
      muted
        ? 'border-dashed border-gray-300 bg-gray-50 text-gray-500 hover:bg-gray-100 focus-within:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:focus-within:bg-gray-700'
        : 'border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200 focus-within:bg-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 dark:focus-within:bg-gray-600'
    }`}
  >
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      aria-label={ariaLabel ?? label}
      title={title}
      className="flex h-7 items-center rounded-full px-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <span className="flex shrink-0 items-center" aria-hidden="true">
        {icon}
      </span>
      <span className="max-w-0 overflow-hidden whitespace-nowrap transition-[max-width,margin] duration-200 ease-out group-hover:ml-1 group-hover:max-w-[12rem] group-focus-within:ml-1 group-focus-within:max-w-[12rem] motion-reduce:transition-none">
        {label}
      </span>
    </button>
    {onRemove && (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        aria-label={removeLabel}
        title={removeLabel}
        className="flex h-7 w-0 items-center justify-center overflow-hidden rounded-full text-gray-500 opacity-0 transition-[width,opacity] duration-200 ease-out hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 group-hover:w-6 group-hover:opacity-100 group-focus-within:w-6 group-focus-within:opacity-100 motion-reduce:transition-none dark:text-gray-400 dark:hover:text-gray-100"
      >
        <IconX size={11} aria-hidden="true" />
      </button>
    )}
  </span>
);
