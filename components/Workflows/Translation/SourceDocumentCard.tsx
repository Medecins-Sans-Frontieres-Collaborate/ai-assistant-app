'use client';

import { IconFileText, IconX } from '@tabler/icons-react';
import { ReactNode } from 'react';

import { useTranslations } from 'next-intl';

import { formatBytes } from '@/lib/utils/app/storage/storageUtils';

import { TranslationSourceDocument } from '@/types/workflow';

interface SourceDocumentCardProps {
  /** The uploaded document the source text was taken from. */
  document: TranslationSourceDocument;
  /** Blocks removing the document (a run or an upload is in progress). */
  disabled: boolean;
  /** Lets go of the document and clears the source text. */
  onRemove: () => void;
  /** Extra control shown before the remove button, e.g. a view switch. */
  action?: ReactNode;
}

/**
 * The uploaded file shown as an object at the top of the source pane: its
 * name, how many pages it has and its size, with a way to remove it. Makes
 * it plain that what follows is a document's pages, not typed text.
 */
export function SourceDocumentCard({
  document,
  disabled,
  onRemove,
  action,
}: SourceDocumentCardProps) {
  const t = useTranslations('workflows');
  const details = [
    document.lastPage > 0 &&
      t('translation.documentPageCount', { count: document.lastPage }),
    document.size !== undefined && formatBytes(document.size),
  ].filter(Boolean);

  return (
    <div
      data-testid="source-document-card"
      className="mx-3 mt-2 flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700"
    >
      <IconFileText
        size={20}
        className="shrink-0 text-gray-500 dark:text-gray-400"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium text-gray-900 dark:text-gray-100"
          title={document.name}
        >
          {document.name}
        </p>
        {details.length > 0 && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {details.join(' · ')}
          </p>
        )}
      </div>
      {action}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={t('translation.sourceRemoveDocument')}
        title={t('translation.sourceRemoveDocument')}
        className="shrink-0 rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
      >
        <IconX size={14} aria-hidden />
      </button>
    </div>
  );
}
