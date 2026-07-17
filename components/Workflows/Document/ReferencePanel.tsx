'use client';

import { IconFile, IconPlus, IconX } from '@tabler/icons-react';
import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
            title={t('document.referenceChars', {
              chars: String(ref.chars),
            })}
          >
            <IconFile size={12} aria-hidden />
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
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          multiple
          hidden
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>
      {error && (
        <p className="mt-1 text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
