'use client';

import {
  IconAlertTriangle,
  IconDownload,
  IconFileText,
  IconLanguage,
  IconLoader2,
} from '@tabler/icons-react';
import React, { FC, useCallback, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { TRANSLATION_EXPIRY_DAYS } from '@/types/documentTranslation';

import { Tooltip } from '@/components/UI/Tooltip';

import { getDocumentTranslationLanguageByCode } from '@/lib/constants/documentTranslationLanguages';

/**
 * Regex to match document translation blob references.
 * Format: [Translation: filename | lang:code | blob:jobId | ext:extension | expires:ISO_TIMESTAMP]
 */
const TRANSLATION_REFERENCE_REGEX =
  /^\[Translation:\s*(.+?)\s*\|\s*lang:([a-zA-Z-]+)\s*\|\s*blob:([a-fA-F0-9-]+)\s*\|\s*ext:([a-zA-Z0-9]+)\s*\|\s*expires:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\]$/;

/**
 * Parsed document translation reference.
 */
interface TranslationReference {
  /** Translated filename */
  filename: string;
  /** Target language code */
  languageCode: string;
  /** Job/blob ID */
  jobId: string;
  /** File extension */
  extension: string;
  /** Expiration date */
  expiresAt: Date;
}

/**
 * Parses a document translation reference string.
 *
 * @param content - The content string to parse
 * @returns Parsed reference or null if not a valid reference
 */
export function parseTranslationReference(
  content: string,
): TranslationReference | null {
  const match = content.trim().match(TRANSLATION_REFERENCE_REGEX);
  if (!match) return null;
  return {
    filename: match[1],
    languageCode: match[2],
    jobId: match[3],
    extension: match[4],
    expiresAt: new Date(match[5]),
  };
}

/**
 * Checks if a content string is a document translation reference.
 *
 * @param content - The content string to check
 * @returns True if the content is a translation reference
 */
export function isDocumentTranslationReference(content: string): boolean {
  return TRANSLATION_REFERENCE_REGEX.test(content.trim());
}

/**
 * Calculates days until expiration.
 */
function getDaysUntilExpiry(expiresAt: Date): number {
  const now = new Date();
  const diffMs = expiresAt.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Formats the translation reference for storage in message content.
 *
 * @param filename - Translated filename
 * @param languageCode - Target language code
 * @param jobId - Job/blob ID
 * @param extension - File extension
 * @param expiresAt - ISO timestamp string
 * @returns Formatted reference string
 */
export function formatTranslationReference(
  filename: string,
  languageCode: string,
  jobId: string,
  extension: string,
  expiresAt: string,
): string {
  return `[Translation: ${filename} | lang:${languageCode} | blob:${jobId} | ext:${extension} | expires:${expiresAt}]`;
}

interface DocumentTranslationViewerProps {
  /** The translation reference content */
  content: string;
}

/**
 * Displays a translated document with download capability.
 */
export const DocumentTranslationViewer: FC<DocumentTranslationViewerProps> = ({
  content,
}) => {
  const t = useTranslations();
  const [isDownloading, setIsDownloading] = useState(false);

  // Parse the reference
  const reference = useMemo(
    () => parseTranslationReference(content),
    [content],
  );

  // Calculate expiration state
  const isExpired = reference
    ? getDaysUntilExpiry(reference.expiresAt) <= 0
    : false;
  const daysUntilExpiry = reference
    ? getDaysUntilExpiry(reference.expiresAt)
    : null;
  const showExpirationWarning =
    daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry <= 2;

  // Get language info
  const languageInfo = reference
    ? getDocumentTranslationLanguageByCode(reference.languageCode)
    : null;
  const languageDisplay = languageInfo
    ? `${languageInfo.nativeName} (${languageInfo.englishName})`
    : reference?.languageCode || 'Unknown';
  const isUnofficialLanguage =
    !!languageInfo && !languageInfo.officiallySupported;

  // Handle download
  const handleDownload = useCallback(async () => {
    if (!reference || isExpired) return;

    setIsDownloading(true);

    try {
      const response = await fetch(
        `/api/document-translation/content/${reference.jobId}?filename=${encodeURIComponent(reference.filename)}&ext=${reference.extension}`,
      );

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(t('documentTranslation.documentNotFound'));
        }
        throw new Error(t('documentTranslation.downloadFailed'));
      }

      // Get the blob and create download link
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = reference.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(t('documentTranslation.downloadSuccess'));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      toast.error(errorMessage);
      console.error('[DocumentTranslationViewer] Download error:', error);
    } finally {
      setIsDownloading(false);
    }
  }, [reference, isExpired, t]);

  // If parsing failed, show error
  if (!reference) {
    return (
      <div className="my-4 p-4 border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20 rounded-lg">
        <p className="text-sm text-red-600 dark:text-red-400">
          {t('documentTranslation.invalidReference')}
        </p>
      </div>
    );
  }

  return (
    <div className="my-4">
      {/* Main container */}
      <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800">
        {/* Header with language badge */}
        <div className="flex items-center justify-between px-4 py-3 bg-gray-100 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600">
          <div className="flex items-center gap-3">
            <IconFileText size={20} className="text-blue-500 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                {reference.filename}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <IconLanguage size={14} className="text-indigo-500" />
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  {t('documentTranslation.translatedTo', {
                    language: languageDisplay,
                  })}
                </span>
                {isUnofficialLanguage && (
                  <Tooltip
                    content={t('documentTranslation.unofficialLanguageWarning')}
                    position="bottom"
                    multiline
                  >
                    <IconAlertTriangle
                      size={14}
                      className="text-amber-600 dark:text-amber-400"
                      aria-label={t('documentTranslation.unofficialBadgeLabel')}
                    />
                  </Tooltip>
                )}
              </div>
            </div>
          </div>

          {/* Download button */}
          <button
            onClick={handleDownload}
            disabled={isDownloading || isExpired}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              isDownloading || isExpired
                ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {isDownloading ? (
              <>
                <IconLoader2 size={16} className="animate-spin" />
                {t('documentTranslation.downloading')}
              </>
            ) : (
              <>
                <IconDownload size={16} />
                {t('documentTranslation.download')}
              </>
            )}
          </button>
        </div>

        {/* Expiration info */}
        <div className="px-4 py-3">
          {isExpired ? (
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <IconAlertTriangle size={16} />
              <span className="text-sm">
                {t('documentTranslation.expired')}
              </span>
            </div>
          ) : showExpirationWarning ? (
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <IconAlertTriangle size={16} />
              <span className="text-sm">
                {t('documentTranslation.expiresSoon', {
                  days: daysUntilExpiry,
                })}
              </span>
            </div>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('documentTranslation.expires', {
                days: daysUntilExpiry || TRANSLATION_EXPIRY_DAYS,
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default DocumentTranslationViewer;
