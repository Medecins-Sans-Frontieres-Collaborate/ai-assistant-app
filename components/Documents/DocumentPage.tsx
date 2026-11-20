'use client';

import { KeyboardEvent, ReactNode, useState } from 'react';

import { PAGE_SURFACE_ATTRIBUTE } from '@/client/hooks/documents/usePageZoom';

import { groupKeyTarget } from '@/lib/utils/client/keyboardScope';
import {
  PageSize,
  PercentBox,
  pageBox,
} from '@/lib/utils/shared/documents/pageGeometry';

/**
 * How an overlay is drawn. `normal` is a plain outline; `warning` and
 * `error` mark something a person should look at; `edited` marks a change
 * not yet on the picture. The selected overlay is always drawn as selected.
 */
export type PageOverlayTone = 'normal' | 'warning' | 'error' | 'edited';

/** A box over a page that can be chosen (a text block, a finding). */
export interface PageOverlay {
  id: string;
  /** `[x0, y0, x1, y1]` in page points from the top-left corner. */
  box: [number, number, number, number];
  tone: PageOverlayTone;
  /** What a screen reader says for it. */
  label: string;
  /** Not drawn (e.g. while a field takes its place); stays in the order. */
  hidden?: boolean;
}

/** Width of a page that is not zoomed: the pane's, up to a normal page. */
export const PAGE_WIDTH = 'min(100%, 36rem)';

/** Marks an overlay's button by its id. */
export const OVERLAY_ATTRIBUTE = 'data-overlay-id';
/** Where an overlay's button is: always 'page' here (lists use 'list'). */
export const OVERLAY_PLACE_ATTRIBUTE = 'data-overlay-place';

const TONE_CLASS: Record<PageOverlayTone, { shown: string; quiet: string }> = {
  normal: {
    shown: 'border border-blue-400/40 hover:border-blue-400',
    quiet: 'border border-transparent hover:border-blue-400/70',
  },
  warning: {
    shown: 'border border-amber-400/80',
    quiet: 'border border-transparent hover:border-blue-400/70',
  },
  error: {
    shown: 'border-2 border-red-500/80 bg-red-500/5',
    quiet: 'border-2 border-red-500/80 bg-red-500/5',
  },
  edited: {
    shown: 'border-2 border-dashed border-amber-400',
    quiet: 'border-2 border-dashed border-amber-400',
  },
};

const SELECTED_CLASS = 'border-2 border-blue-500 bg-blue-500/10';

export interface DocumentPageProps {
  /** The page's picture (a data or object URL), or null while it loads. */
  image: string | null;
  /** What a screen reader says for the picture ("Slide 3"). */
  imageLabel: string;
  /** What a screen reader says while it loads. */
  loadingLabel: string;
  /** The page's size in points; needed only to place overlays. */
  size?: PageSize | null;
  overlays?: PageOverlay[];
  selectedId?: string | null;
  /** Outline every overlay, not only the selected one and those to look at. */
  outlines?: boolean;
  /** CSS width of the page (the zoom); absent fills up to a normal page. */
  width?: string;
  onSelect?: (id: string) => void;
  /**
   * Drawn above the picture and overlays, in the page's own coordinates:
   * use {@link placeOnPage} to position something over a box.
   */
  children?: ReactNode;
  /** Test id of the page element. */
  testId?: string;
}

/**
 * Where a box in page points is drawn over a page of `size`, as CSS
 * percentages (so it scales with the picture at any zoom).
 */
export function placeOnPage(
  box: [number, number, number, number],
  size: PageSize,
): PercentBox {
  return pageBox(box, size);
}

/**
 * One page: its picture with boxes over it that can be chosen.
 *
 * The boxes are one Tab stop: arrow keys move between them in the order
 * given, Home and End go to the first and last, and Enter or Space chooses
 * one. Nothing about what a box means is known here; the screen that uses
 * the page supplies the boxes, their labels and what choosing does.
 */
export function DocumentPage({
  image,
  imageLabel,
  loadingLabel,
  size,
  overlays = [],
  selectedId = null,
  outlines = true,
  width = PAGE_WIDTH,
  onSelect,
  children,
  testId = 'document-page',
}: DocumentPageProps) {
  // The box that takes the Tab stop: the last one the keyboard was on.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  if (!image) {
    return (
      <div
        role="status"
        aria-label={loadingLabel}
        {...{ [PAGE_SURFACE_ATTRIBUTE]: '' }}
        style={{ width }}
        className="m-auto aspect-[210/297] shrink-0 animate-pulse rounded bg-gray-200 dark:bg-surface-dark-elevated"
      />
    );
  }
  const placed = size ? overlays.filter((overlay) => !overlay.hidden) : [];
  const tabStop = [focusedId, selectedId, placed[0]?.id].find(
    (id) => id && placed.some((overlay) => overlay.id === id),
  );
  /** Arrow keys, Home and End move between the boxes (see above). */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = (event.target as HTMLElement).closest(
      `[${OVERLAY_PLACE_ATTRIBUTE}="page"]`,
    );
    if (!from || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        `[${OVERLAY_PLACE_ATTRIBUTE}="page"]`,
      ),
    );
    const to = groupKeyTarget(
      event.key,
      buttons.indexOf(from as HTMLElement),
      buttons.length,
      'both',
    );
    if (to === null) return;
    event.preventDefault();
    buttons[to].focus();
  };
  return (
    // Auto margins centre the page and, unlike centring the row, leave a
    // zoomed page's left edge reachable by scrolling.
    <div
      data-testid={testId}
      {...{ [PAGE_SURFACE_ATTRIBUTE]: '' }}
      style={{ width }}
      onKeyDown={onKeyDown}
      className="relative mx-auto shrink-0 self-start"
    >
      {/* A rendered page served as a data URL. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image}
        alt={imageLabel}
        draggable={false}
        className="block w-full select-none rounded-sm"
      />
      {size &&
        placed.map((overlay) => {
          const isSelected = overlay.id === selectedId;
          const look = TONE_CLASS[overlay.tone];
          const border = isSelected
            ? SELECTED_CLASS
            : outlines
              ? look.shown
              : look.quiet;
          return (
            <button
              key={overlay.id}
              type="button"
              aria-label={overlay.label}
              aria-pressed={isSelected}
              {...{
                [OVERLAY_ATTRIBUTE]: overlay.id,
                [OVERLAY_PLACE_ATTRIBUTE]: 'page',
              }}
              tabIndex={overlay.id === tabStop ? 0 : -1}
              onFocus={() => setFocusedId(overlay.id)}
              onClick={() => onSelect?.(overlay.id)}
              style={placeOnPage(overlay.box, size)}
              className={`absolute rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${border}`}
            />
          );
        })}
      {children}
    </div>
  );
}
