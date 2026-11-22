'use client';

import { ReactNode, createContext, useCallback, useContext } from 'react';

import { useTranslations } from 'next-intl';

/**
 * Whether the formatted screens are about a document's pages or a
 * presentation's slides, and the words that follow from it.
 *
 * Strings that name the unit have a slide twin under
 * `workflows.translation.formatted.slides.<key>` (SLIDE_WORDED_KEYS); the
 * rest are the same for both. The workspace sets the unit once for the
 * document it shows.
 */

export type FormattedUnit = 'page' | 'slide';

/** Keys under `translation.formatted` that have a slide twin. */
export const SLIDE_WORDED_KEYS = [
  'pageLabel',
  'loadingPage',
  'removePage',
  'restorePage',
  'translateThisPage',
  'pageUntranslatedNote',
  'pageRemovedNote',
  'unchecked',
  'wholePage',
  'translatePages',
  'sourcePages',
  'pagesField',
  'previewsLoading',
  'previewsUnavailable',
  'progressTitle',
  'progressAssembling',
  'documentSummary',
  'batchSize',
  'previewsFirst',
  'pageReason.later',
  'pageReason.laterRaise',
  'pageReason.locked',
] as const;

export type SlideWordedKey = (typeof SLIDE_WORDED_KEYS)[number];

const FormattedUnitContext = createContext<FormattedUnit>('page');

/** Sets the unit the formatted screens inside it speak of. */
export function FormattedUnitProvider({
  unit,
  children,
}: {
  unit: FormattedUnit;
  children: ReactNode;
}) {
  return (
    <FormattedUnitContext.Provider value={unit}>
      {children}
    </FormattedUnitContext.Provider>
  );
}

/** The unit the formatted screens speak of here. */
export function useFormattedUnit(): FormattedUnit {
  return useContext(FormattedUnitContext);
}

/**
 * Translates one of SLIDE_WORDED_KEYS in the unit set by the nearest
 * FormattedUnitProvider (pages outside one).
 *
 * @returns `(key, values?) => string`.
 * @example
 * const unitT = useUnitWording();
 * unitT('pageLabel', { page: 3 }); // "Slide 3" for a presentation
 */
export function useUnitWording() {
  const t = useTranslations('workflows');
  const unit = useFormattedUnit();
  return useCallback(
    (key: SlideWordedKey, values?: Record<string, string | number>): string =>
      t(
        unit === 'slide'
          ? `translation.formatted.slides.${key}`
          : `translation.formatted.${key}`,
        values,
      ),
    [t, unit],
  );
}
