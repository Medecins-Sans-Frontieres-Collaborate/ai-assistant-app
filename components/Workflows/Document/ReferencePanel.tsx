'use client';

import {
  IconAlertTriangle,
  IconFile,
  IconLink,
  IconPlus,
  IconWorld,
  IconX,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { buildFailureDocument } from '@/client/services/url/urlAttachment';
import {
  fetchUrlContent,
  hostnameOf,
  isLikelyUrl,
  urlErrorKey,
} from '@/client/services/url/urlFetchClient';
import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';

import { DocumentReference } from '@/types/workflow';

const ACCEPTED =
  '.pdf,.doc,.docx,.txt,.md,.json,.xml,.csv,.xls,.xlsx,.ppt,.pptx';

interface ReferencePanelProps {
  references: DocumentReference[];
  onAdd: (reference: DocumentReference, text: string) => void;
  onRemove: (fileId: string) => void;
  disabled?: boolean;
}

/**
 * Compact strip of reference files whose extracted text the document
 * workflow cites from. Reference text is held in memory by the workspace
 * and re-fetched on demand; only metadata persists in workflowState.
 */
export function ReferencePanel({
  references,
  onAdd,
  onRemove,
  disabled,
}: ReferencePanelProps) {
  const t = useTranslations('workflows');
  const tUrl = useTranslations('urlFetch');
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlValue, setUrlValue] = useState('');

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const extracted = await uploadAndExtractText(file);
        if (!extracted.text.trim()) {
          setError(t('document.referenceEmpty', { name: file.name }));
          continue;
        }
        onAdd(
          {
            fileId: extracted.url || `local-${file.name}-${file.size}`,
            name: file.name,
            url: extracted.url,
            chars: extracted.text.length,
          },
          extracted.text,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('document.uploadFailed'));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  /**
   * Adds a web page as a reference. A page that cannot be retrieved is still
   * added, with the failure explanation as its text — the document model is
   * then told why a source it was pointed at is empty, instead of silently
   * citing nothing.
   */
  const handleAddUrl = async (rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url || uploading) return;
    if (!isLikelyUrl(url)) {
      setError(tUrl('attachLinkInvalid'));
      return;
    }
    if (references.some((ref) => ref.fileId === url)) {
      setUrlValue('');
      setUrlOpen(false);
      return;
    }

    setError(null);
    setUploading(true);
    try {
      const result = await fetchUrlContent(url);
      if (result.ok) {
        const { text, title, resolvedUrl } = result.page;
        onAdd(
          {
            fileId: url,
            name: title.trim() || hostnameOf(resolvedUrl) || url,
            url: resolvedUrl,
            chars: text.length,
            kind: 'url',
          },
          text,
        );
      } else {
        const reason = tUrl(urlErrorKey(result.code));
        const doc = buildFailureDocument(url, {
          heading: tUrl('doc.failureHeading'),
          sourceLabel: tUrl('doc.sourceLabel'),
          attemptedLabel: tUrl('doc.attemptedLabel'),
          reason,
          hint: tUrl('fallbackHint'),
        });
        onAdd(
          {
            fileId: url,
            name: hostnameOf(url) || url,
            url,
            chars: doc.length,
            kind: 'url',
            error: reason,
          },
          doc,
        );
      }
      setUrlValue('');
      setUrlOpen(false);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          {t('document.references')}
        </span>
        {references.map((ref) => (
          <span
            key={ref.fileId}
            className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300"
            title={
              ref.error ??
              t('document.referenceChars', { chars: String(ref.chars) })
            }
          >
            {ref.error ? (
              <IconAlertTriangle
                size={12}
                aria-hidden
                className="text-amber-600 dark:text-amber-400"
              />
            ) : ref.kind === 'url' ? (
              <IconWorld size={12} aria-hidden />
            ) : (
              <IconFile size={12} aria-hidden />
            )}
            <span className="max-w-[16ch] truncate">{ref.name}</span>
            <button
              type="button"
              onClick={() => onRemove(ref.fileId)}
              aria-label={t('document.removeReference', { name: ref.name })}
              className="rounded p-0.5 hover:bg-gray-200 dark:hover:bg-gray-700"
              disabled={disabled}
            >
              <IconX size={12} aria-hidden />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || uploading}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconPlus size={13} aria-hidden />
          {uploading ? t('document.uploading') : t('document.addReference')}
        </button>
        <button
          type="button"
          onClick={() => setUrlOpen((open) => !open)}
          disabled={disabled || uploading}
          aria-expanded={urlOpen}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconLink size={13} aria-hidden />
          {tUrl('addLink')}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          multiple
          hidden
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>
      {urlOpen && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="url"
            value={urlValue}
            autoFocus
            disabled={disabled || uploading}
            placeholder={tUrl('attachLinkPlaceholder')}
            aria-label={tUrl('addLink')}
            onChange={(e) => setUrlValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAddUrl(urlValue);
              } else if (e.key === 'Escape') {
                setUrlOpen(false);
              }
            }}
            onPaste={(e) => {
              // Pasting a link here means "add this" — no second click.
              const pasted = e.clipboardData.getData('text/plain').trim();
              if (isLikelyUrl(pasted)) {
                e.preventDefault();
                setUrlValue(pasted);
                void handleAddUrl(pasted);
              }
            }}
            className="min-w-0 flex-1 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
          />
          <button
            type="button"
            onClick={() => void handleAddUrl(urlValue)}
            disabled={disabled || uploading || !urlValue.trim()}
            className="shrink-0 rounded-lg bg-gray-300 px-2 py-1 text-xs font-medium text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            {uploading ? t('document.uploading') : tUrl('attachLinkSubmit')}
          </button>
        </div>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
