/**
 * Document Translation Content Component
 *
 * Lightweight wrapper for displaying document translation references
 * in chat messages. Parses the reference and renders the viewer.
 */
'use client';

import React, { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import {
  DocumentTranslationViewer,
  parsePendingTranslationReference,
  parseTranslationReference,
} from '@/components/Chat/DocumentTranslationViewer';

/**
 * Document Translation Content Component
 *
 * Lightweight wrapper for displaying document translation references
 * in chat messages. Parses the reference and renders the viewer.
 */

/**
 * Document Translation Content Component
 *
 * Lightweight wrapper for displaying document translation references
 * in chat messages. Parses the reference and renders the viewer.
 */

/**
 * Document Translation Content Component
 *
 * Lightweight wrapper for displaying document translation references
 * in chat messages. Parses the reference and renders the viewer.
 */

/**
 * Document Translation Content Component
 *
 * Lightweight wrapper for displaying document translation references
 * in chat messages. Parses the reference and renders the viewer.
 */

/**
 * Document Translation Content Component
 *
 * Lightweight wrapper for displaying document translation references
 * in chat messages. Parses the reference and renders the viewer.
 */

interface DocumentTranslationContentProps {
  /** The content containing the translation reference */
  content: string;
}

/**
 * Renders document translation content in chat messages.
 */
export const DocumentTranslationContent: FC<
  DocumentTranslationContentProps
> = ({ content }) => {
  const t = useTranslations();

  // Parse reference to check validity — COMPLETED ([Translation: …]) and
  // PENDING async-batch ([TranslationPending: …]) markers are both valid;
  // the viewer renders the progress/polling card for pending ones.
  const isRenderable = useMemo(
    () =>
      parseTranslationReference(content) !== null ||
      parsePendingTranslationReference(content) !== null,
    [content],
  );

  // If parsing failed, show error message
  if (!isRenderable) {
    return (
      <div className="my-4 p-4 border border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-900/20 rounded-lg">
        <p className="text-sm text-yellow-800 dark:text-yellow-200">
          {t('documentTranslation.invalidReference')}
        </p>
      </div>
    );
  }

  // Render the translation viewer
  return <DocumentTranslationViewer content={content} />;
};

export default DocumentTranslationContent;
