'use client';

import { ReactNode } from 'react';

import { useTranslations } from 'next-intl';

import { NO_PAN_ATTRIBUTE } from '@/client/hooks/documents/usePagePan';

import {
  FormattedDocumentRun,
  movedBox,
  textRows,
} from '@/lib/utils/shared/translation/formattedDocument';
import {
  NativePdfPageStats,
  NativePdfUnitResult,
  NativePdfUnitStyle,
  SCALE_EPSILON,
} from '@/lib/utils/shared/translation/nativePdf';

import {
  DocumentPage,
  OVERLAY_ATTRIBUTE,
  OVERLAY_PLACE_ATTRIBUTE,
  PAGE_WIDTH,
  PageOverlay,
  placeOnPage,
} from '@/components/Documents/DocumentPage';

import { useUnitWording } from './formattedWording';

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
  /** Put the keyboard in the field when it opens (it was opened here). */
  focusField: boolean;
  onSelect: (id: string) => void;
  onDraftChange: (text: string) => void;
}

/** Marks a block's button, here and in the block list, by unit id. */
export const UNIT_ATTRIBUTE = OVERLAY_ATTRIBUTE;
/** Where a block's button is: 'page' (here) or 'list'. */
export const UNIT_PLACE_ATTRIBUTE = OVERLAY_PLACE_ATTRIBUTE;

/** Smallest field shown over the page, so a one-word block stays typeable. */
const MIN_FIELD_WIDTH_PX = 220;

/**
 * One translated page with its text blocks marked, on the documents layer's
 * page (DocumentPage). Every block is a box over the place it occupies; the
 * selected block of the translated page becomes a text field in that same
 * place, so the words are edited where they sit. What is typed is not on
 * the image until the page is re-rendered.
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
  focusField,
  onSelect,
  onDraftChange,
}: FormattedPageViewProps) {
  const t = useTranslations('workflows');
  const unitT = useUnitWording();
  /** Where a block is drawn: its measured place, moved as the person asked. */
  const placed = (
    unit: NativePdfUnitResult,
    box: NativePdfUnitResult['bbox'],
  ) => movedBox(box, styles?.[unit.id]);
  const overlays: PageOverlay[] = units.map((unit) => {
    const edited = unit.id in edits || !!restyled?.has(unit.id);
    const shrunk =
      !edited && unit.scale !== null && unit.scale < 1 - SCALE_EPSILON;
    return {
      id: unit.id,
      box: placed(unit, unit.bbox),
      tone: edited ? 'edited' : shrunk ? 'warning' : 'normal',
      label: t('translation.formatted.blockLabel', { n: unit.n }),
      // The open field takes the selected block's place.
      hidden: unit.id === selectedId && draft !== null,
    };
  });
  const selected = units.find((unit) => unit.id === selectedId);
  return (
    <DocumentPage
      testId="formatted-page"
      image={image}
      imageLabel={unitT('pageLabel', { page: page.page })}
      loadingLabel={unitT('loadingPage', { page: page.page })}
      size={page}
      overlays={overlays}
      selectedId={selectedId}
      outlines={outlines}
      width={width}
      onSelect={onSelect}
    >
      {selected && (
        <span
          aria-hidden
          style={{
            left: placeOnPage(placed(selected, selected.bbox), page).left,
            top: placeOnPage(placed(selected, selected.bbox), page).top,
          }}
          className="absolute -ms-1 -translate-x-full rounded bg-blue-600 px-1.5 text-[11px] font-semibold text-white rtl:translate-x-full"
        >
          {selected.n}
        </span>
      )}
      {selected && draft !== null && (
        <div
          {...{ [UNIT_ATTRIBUTE]: selected.id, [NO_PAN_ATTRIBUTE]: '' }}
          style={{
            left: placeOnPage(placed(selected, selected.room), page).left,
            top: placeOnPage(placed(selected, selected.room), page).top,
            width: placeOnPage(placed(selected, selected.room), page).width,
            minWidth: MIN_FIELD_WIDTH_PX,
          }}
          className="absolute z-10 flex max-w-full flex-col gap-1"
        >
          <textarea
            autoFocus={focusField}
            rows={textRows(draft, 70, { min: 1, max: 10 })}
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
    </DocumentPage>
  );
}
