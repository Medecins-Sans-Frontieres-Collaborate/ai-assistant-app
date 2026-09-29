'use client';

import { ReactNode } from 'react';

import { CitationVerdict } from '@/types/drafter';

import { Popover } from './Popover';

interface CitationChipProps {
  /** '2', '2,5', 'KM'; empty when the sentence rests on nothing known. */
  tag: string;
  verdict: CitationVerdict;
  /** What the chip announces and shows on hover: the sentence's state. */
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Hover or focus on the chip traces the sentence's first item. */
  onTrace: (on: boolean) => void;
  /** The popover's contents. */
  children: ReactNode;
}

const CHIP =
  'ms-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 align-baseline text-[11px] font-semibold tabular-nums leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600';

/**
 * The one interactive element of a sentence: a small superscript-like chip
 * after it with the numbers of the brief items it rests on, opening the
 * sentence's evidence in a popover anchored to itself. The sentence text
 * stays plain text, so a click on it still opens the editor.
 *
 * It sits outside the underlined span (a child cannot cancel an ancestor's
 * underline) and swallows its own mouse events, so a press on it is never
 * a press on the post.
 */
export function CitationChip({
  tag,
  verdict,
  label,
  open,
  onToggle,
  onClose,
  onTrace,
  children,
}: CitationChipProps) {
  const problem =
    verdict === 'unsupported' || verdict === 'unclear' || verdict === 'stale';
  const tone = problem
    ? 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-200'
    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-surface-dark-elevated dark:text-gray-300';
  return (
    <span
      className="relative inline-block"
      // The popover is a sibling of the chip inside the post's text: a
      // press in either must not reach the post (which opens the editor)
      // nor the document (which closes the popover).
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`${CHIP} ${tone}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseEnter={() => onTrace(true)}
        onMouseLeave={() => onTrace(false)}
        onFocus={() => onTrace(true)}
        onBlur={() => onTrace(false)}
        onClick={onToggle}
      >
        {verdict === 'pending' ? (
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-gray-500 motion-reduce:animate-none dark:bg-gray-400"
          />
        ) : (
          <span aria-hidden>{tag || '?'}</span>
        )}
      </button>
      <Popover
        open={open}
        onClose={onClose}
        placement="below-start"
        className="w-80 p-2 text-start font-normal normal-case"
      >
        <div role="dialog" aria-label={label}>
          {children}
        </div>
      </Popover>
    </span>
  );
}
