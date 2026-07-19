'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  type WordDiffPart,
  diffWords,
} from '@/lib/utils/shared/review/editApplication';
import {
  locateEdits,
  resolvePreviewText,
} from '@/lib/utils/shared/review/editLocation';

import { EditQuickActions, type PinPoint } from './EditQuickActions';

/** The pending edits worth marking up; resolved ones are already in the text. */
export interface AnnotatableEdit {
  id: string;
  before: string;
  after: string;
}

interface AnnotatedTextProps {
  text: string;
  edits: readonly AnnotatableEdit[];
  /** The edit being previewed — hovered card, or the pinned span. */
  activeId: string | null;
  /** The clicked (pinned) edit; only this one gets the quick actions. */
  pinnedId: string | null;
  /** A span was clicked (or Enter/Space'd); null when dismissed. */
  onPin: (id: string | null) => void;
  /** Hover over a span, so the matching card can highlight in step. */
  onHover: (id: string | null) => void;
  i18nNamespace: string;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  disabled?: boolean;
  className?: string;
}

/** Resting marker: present enough to notice, quiet enough to read past. */
const RESTING =
  'cursor-pointer rounded-sm bg-amber-100/60 underline decoration-amber-400/70 decoration-dotted underline-offset-2 hover:bg-amber-100 dark:bg-amber-400/10 dark:decoration-amber-500/60 dark:hover:bg-amber-400/20';

/** Active: the same span, opened up into a diff and ringed. */
const ACTIVE =
  'cursor-pointer rounded-sm bg-amber-100 ring-1 ring-amber-400/70 dark:bg-amber-400/15 dark:ring-amber-500/50';

function DiffedSpan({
  parts,
  ...rest
}: { parts: WordDiffPart[] } & React.HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);

  // Mounts only while active, so bringing it into view on mount is enough —
  // the card can sit far from the text it refers to.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  return (
    <mark ref={ref} className={`p-0 text-inherit ${ACTIVE}`} {...rest}>
      {parts.map((part, i) =>
        part.kind === 'same' ? (
          <span key={i}>{part.text}</span>
        ) : part.kind === 'del' ? (
          <del
            key={i}
            className="bg-red-100 text-red-700 decoration-red-400 dark:bg-red-900/40 dark:text-red-300"
          >
            {part.text}
          </del>
        ) : (
          <ins
            key={i}
            className="bg-green-100 text-green-800 no-underline dark:bg-green-900/40 dark:text-green-300"
          >
            {part.text}
          </ins>
        ),
      )}
    </mark>
  );
}

/**
 * Read-only text with its pending edits marked in place: every suggestion
 * gets a quiet resting highlight so the user can see where the review
 * landed, the active one expands into the same word diff the card shows,
 * and clicking a span pins it with accept/reject right there — so a change
 * can be decided from the text without ever finding its card.
 */
export function AnnotatedText({
  text,
  edits,
  activeId,
  pinnedId,
  onPin,
  onHover,
  i18nNamespace,
  onAccept,
  onReject,
  disabled,
  className,
}: AnnotatedTextProps) {
  const rootRef = useRef<HTMLElement>(null);
  // The point belongs to the pin, so it is stored keyed by the edit it was
  // captured for and derived during render. Losing the pin loses the point
  // with no effect round-trip, and a pin moved from outside (parent-driven)
  // can't render its bar at the previous pin's position.
  const [pinAnchor, setPinAnchor] = useState<{
    id: string;
    point: PinPoint;
  } | null>(null);
  const pinPoint = pinAnchor?.id === pinnedId ? pinAnchor.point : null;

  const marks = useMemo(() => {
    const searchable = edits
      .map((edit) => {
        const resolved = resolvePreviewText(text, edit.before, edit.after);
        return resolved ? { id: edit.id, ...resolved } : null;
      })
      .filter((edit): edit is AnnotatableEdit => edit !== null);

    const byId = new Map(searchable.map((edit) => [edit.id, edit]));
    return locateEdits(text, searchable).map((location) => ({
      ...location,
      edit: byId.get(location.id)!,
    }));
  }, [text, edits]);

  if (marks.length === 0) {
    return <span className={className}>{text}</span>;
  }

  /** Viewport coords → coords inside the (scrolling) root element. */
  const toLocalPoint = (clientX: number, clientY: number): PinPoint => {
    const root = rootRef.current;
    if (!root) return { x: clientX, y: clientY };
    const rect = root.getBoundingClientRect();
    // Keep the bar inside the text column — but only once the column has a
    // real width, or an unlaid-out container would pin everything to x=0.
    const maxX = rect.width > 60 ? rect.width - 56 : Infinity;
    return {
      x: Math.min(clientX - rect.left + 4, maxX),
      y: clientY - rect.top,
    };
  };

  const pin = (id: string, point: PinPoint) => {
    if (pinnedId === id) {
      onPin(null);
      return;
    }
    setPinAnchor({ id, point });
    onPin(id);
  };

  /** Click/hover/keyboard wiring shared by the resting and active spans. */
  const interaction = (id: string) => ({
    role: 'button' as const,
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      // Don't let the wrapper's dismiss-on-outside-click undo this.
      e.stopPropagation();
      pin(id, toLocalPoint(e.clientX, e.clientY));
    },
    onMouseEnter: () => onHover(id),
    onMouseLeave: () => onHover(null),
    onFocus: () => onHover(id),
    onBlur: () => onHover(null),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      // No cursor to anchor to: fall back to the start of the span itself.
      const rect = e.currentTarget.getBoundingClientRect();
      pin(id, toLocalPoint(rect.left, rect.bottom));
    },
  });

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start > cursor) {
      nodes.push(
        <span key={`t${cursor}`}>{text.slice(cursor, mark.start)}</span>,
      );
    }
    const slice = text.slice(mark.start, mark.end);
    nodes.push(
      mark.id === activeId ? (
        <DiffedSpan
          key={mark.id}
          parts={diffWords(slice, mark.edit.after)}
          {...interaction(mark.id)}
        />
      ) : (
        <mark
          key={mark.id}
          className={`p-0 text-inherit ${RESTING}`}
          {...interaction(mark.id)}
        >
          {slice}
        </mark>
      ),
    );
    cursor = mark.end;
  }
  if (cursor < text.length) {
    nodes.push(<span key={`t${cursor}`}>{text.slice(cursor)}</span>);
  }

  return (
    <span
      ref={rootRef}
      // `relative block` makes this the positioning context for the action
      // bar, so the bar scrolls with the text instead of detaching from it.
      className={`relative block ${className ?? ''}`}
      // Clicking the surrounding prose dismisses the pinned actions; the
      // spans and the action bar stop their own clicks from reaching here.
      onClick={() => pinnedId && onPin(null)}
    >
      {nodes}
      {pinnedId && pinPoint && (
        <EditQuickActions
          editId={pinnedId}
          i18nNamespace={i18nNamespace}
          position={pinPoint}
          onAccept={onAccept}
          onReject={onReject}
          disabled={disabled}
        />
      )}
    </span>
  );
}
