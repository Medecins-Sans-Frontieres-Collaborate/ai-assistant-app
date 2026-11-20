'use client';

import { IconNotes } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

interface SlideNotesProps {
  /** The slide's speaker notes in the original. */
  source?: string;
  /** The notes as delivered: translated, or the original kept. */
  translation?: string;
}

/**
 * A slide's speaker notes in the whole-document reader, folded away under
 * the reader bar: the original beside what the translated deck carries.
 * Notes kept in the original language (the person chose not to translate
 * them) are said to be kept rather than shown twice. Renders nothing for a
 * slide without notes.
 */
export function SlideNotes({ source, translation }: SlideNotesProps) {
  const t = useTranslations('workflows');
  if (!source?.trim() && !translation?.trim()) return null;
  const kept = !!source && source === translation;
  return (
    <details className="group border-b border-gray-200 px-3 py-1.5 text-xs dark:border-gray-700">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">
        <IconNotes size={14} aria-hidden />
        {t('translation.slides.notes')}
        {kept && (
          <span className="text-gray-500 dark:text-gray-500">
            · {t('translation.slides.notesKept')}
          </span>
        )}
      </summary>
      <div className={`mt-2 grid gap-3 pb-1 ${kept ? '' : 'sm:grid-cols-2'}`}>
        <section aria-label={t('translation.slides.notesOriginal')}>
          {!kept && (
            <h4 className="mb-1 font-medium text-gray-700 dark:text-gray-300">
              {t('translation.slides.notesOriginal')}
            </h4>
          )}
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-gray-700 dark:text-gray-300">
            {source}
          </p>
        </section>
        {!kept && (
          <section aria-label={t('translation.slides.notesTranslation')}>
            <h4 className="mb-1 font-medium text-gray-700 dark:text-gray-300">
              {t('translation.slides.notesTranslation')}
            </h4>
            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-gray-700 dark:text-gray-300">
              {translation}
            </p>
          </section>
        )}
      </div>
    </details>
  );
}
