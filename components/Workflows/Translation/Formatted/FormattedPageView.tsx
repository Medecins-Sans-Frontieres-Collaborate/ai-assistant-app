'use client';

import { ReactNode } from 'react';

import { useTranslations } from 'next-intl';

import {
  FormattedDocumentRun,
  movedBox,
  unitBox,
} from '@/lib/utils/shared/translation/formattedDocument';
import {
  NativePdfPageStats,
  NativePdfUnitResult,
  NativePdfUnitStyle,
  SCALE_EPSILON,
} from '@/lib/utils/shared/translation/nativePdf';

interface FormattedPageViewProps {
  /** Image of the page to show, or null while it loads. */
  image: string | null;
  page: NativePdfPageStats;
  units: NativePdfUnitResult[];
  edits: FormattedDocumentRun['edits'];
  /** Unit id to the look the person wants; a moved block is drawn moved. */
  styles?: Record<string, NativePdfUnitStyle>;
  /** Ids of blocks whose look is not on the page yet. */
  restyled?: ReadonlySet<string>;
  /** CSS width of the page (the zoom); absent fills up to a normal page. */
  width?: string;
  selectedId: string | null;
  /** Draw every block's outline, not only the selected one's. */
  outlines: boolean;
  /**
   * Text of the selected block as it is being typed, when it can be edited
   * on the page (the translated view); null shows no field.
   */
  draft: string | null;
  /** Shown above the field: the block's actions. */
  toolbar?: ReactNode;
  onSelect: (id: string) => void;
  onDraftChange: (text: string) => void;
}

/** Width of a page that is not zoomed: the pane's, up to a normal page. */
export const PAGE_WIDTH = 'min(100%, 36rem)';

/** Smallest field shown over the page, so a one-word block stays typeable. */
const MIN_FIELD_WIDTH_PX = 220;

/**
 * One page with its text blocks marked. Every block is a button over the
 * place it occupies; the selected block of the translated page becomes a
 * text field in that same place, so the words are edited where they sit.
 * What is typed is not on the image until the page is re-rendered.
 */
export function FormattedPageView({
  image,
  page,
  units,
  edits,
  styles,
  restyled,
  width = PAGE_WIDTH,
  selectedId,
  outlines,
  draft,
  toolbar,
  onSelect,
  onDraftChange,
}: FormattedPageViewProps) {
  const t = useTranslations('workflows');
  if (!image) {
    return (
      <div
        role="status"
        style={{ width }}
        className="m-auto aspect-[210/297] shrink-0 animate-pulse rounded bg-gray-200 dark:bg-surface-dark-elevated"
      />
    );
  }
  const selected = units.find((unit) => unit.id === selectedId);
  /** Where a block is drawn: its measured place, moved as the person asked. */
  const place = (unit: NativePdfUnitResult, box: NativePdfUnitResult['bbox']) =>
    unitBox(movedBox(box, styles?.[unit.id]), page);
  return (
    // Auto margins centre the page and, unlike centring the row, leave a
    // zoomed page's left edge reachable by scrolling.
    <div
      data-testid="formatted-page"
      style={{ width }}
      className="relative mx-auto shrink-0 self-start"
    >
      {/* A rendered page served as a data URL. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image}
        alt={t('translation.formatted.pageLabel', { page: page.page })}
        className="block w-full rounded-sm"
      />
      {units.map((unit) => {
        const isSelected = unit.id === selectedId;
        if (isSelected && draft !== null) return null;
        const edited = unit.id in edits || !!restyled?.has(unit.id);
        const shrunk =
          !edited && unit.scale !== null && unit.scale < 1 - SCALE_EPSILON;
        const border = isSelected
          ? 'border-2 border-blue-500 bg-blue-500/10'
          : edited
            ? 'border-2 border-dashed border-amber-400'
            : !outlines
              ? 'border border-transparent hover:border-blue-400/70'
              : shrunk
                ? 'border border-amber-400/80'
                : 'border border-blue-400/40 hover:border-blue-400';
        return (
          <button
            key={unit.id}
            type="button"
            aria-label={t('translation.formatted.blockLabel', { n: unit.n })}
            aria-pressed={isSelected}
            onClick={() => onSelect(unit.id)}
            style={place(unit, unit.bbox)}
            className={`absolute rounded-sm ${border}`}
          />
        );
      })}
      {selected && (
        <span
          aria-hidden
          style={{
            left: place(selected, selected.bbox).left,
            top: place(selected, selected.bbox).top,
          }}
          className="absolute -ms-1 -translate-x-full rounded bg-blue-600 px-1.5 text-[11px] font-semibold text-white rtl:translate-x-full"
        >
          {selected.n}
        </span>
      )}
      {selected && draft !== null && (
        <div
          style={{
            left: place(selected, selected.room).left,
            top: place(selected, selected.room).top,
            width: place(selected, selected.room).width,
            minWidth: MIN_FIELD_WIDTH_PX,
          }}
          className="absolute z-10 flex max-w-full flex-col gap-1"
        >
          <textarea
            autoFocus
            rows={Math.min(Math.max(Math.ceil(draft.length / 70), 1), 10)}
            value={draft}
            aria-label={t('translation.formatted.editOnPage', {
              n: selected.n,
            })}
            onChange={(event) => onDraftChange(event.target.value)}
            className="w-full resize-y rounded border-2 border-blue-500 bg-white px-1.5 py-0.5 text-xs leading-snug text-gray-900 shadow-lg"
          />
          {toolbar && (
            <div className="rounded-lg border border-gray-300 bg-white p-1.5 shadow-lg dark:border-gray-600 dark:bg-surface-dark-base">
              {toolbar}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
