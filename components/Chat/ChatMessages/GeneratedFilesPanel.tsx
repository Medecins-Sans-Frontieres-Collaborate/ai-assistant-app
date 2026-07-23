'use client';

import { IconDownload } from '@tabler/icons-react';
import { FC, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { fetchImageBase64FromMessageContent } from '@/lib/services/imageService';

import type { ToolCallRecord } from '@/types/chat';

import type { GeneratedFileRef } from '@/lib/streamMarkers';

interface GeneratedFilesPanelProps {
  toolCalls: ToolCallRecord[];
}

/** Badge colors keyed by extension family (mirrors the upload-tile look). */
function badgeClassFor(extension: string): string {
  switch (extension) {
    case 'xlsx':
    case 'csv':
      return 'bg-emerald-600';
    case 'pdf':
      return 'bg-red-600';
    case 'docx':
    case 'txt':
    case 'md':
      return 'bg-blue-600';
    case 'pptx':
      return 'bg-orange-600';
    case 'json':
    case 'xml':
    case 'py':
    case 'js':
      return 'bg-violet-600';
    default:
      return 'bg-gray-600';
  }
}

/**
 * Prominent display of files the code interpreter produced this turn.
 * These are the run's deliverable, so they render on the MESSAGE itself
 * (image previews inline, other files as attachment-style download cards) —
 * never buried inside the collapsed "Used N tools" strip.
 */
export const GeneratedFilesPanel: FC<GeneratedFilesPanelProps> = ({
  toolCalls,
}) => {
  const files = toolCalls.flatMap((call) => call.generated_files ?? []);
  if (files.length === 0) return null;

  return (
    <div className="not-prose my-3 flex flex-wrap items-start gap-3">
      {files.map((file) => (
        <GeneratedFileCard key={file.url} file={file} />
      ))}
    </div>
  );
};

interface GeneratedFileCardProps {
  file: GeneratedFileRef;
}

const GeneratedFileCard: FC<GeneratedFileCardProps> = ({ file }) => {
  const t = useTranslations('chat.toolSummary');
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!file.is_image) return;
    fetchImageBase64FromMessageContent({
      type: 'image_url',
      image_url: { url: file.url, detail: 'auto' },
    })
      .then((base64) => {
        if (cancelled) return;
        if (base64) setImageSrc(base64);
        else setImageFailed(true);
      })
      .catch(() => {
        if (!cancelled) setImageFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [file.is_image, file.url]);

  const extension = (file.filename.split('.').pop() ?? '').toLowerCase();

  // Inline preview for images (charts are the most common interpreter
  // output); the download uses the resolved data URL because image bytes
  // are only exposed as base64 by the file route.
  if (file.is_image && !imageFailed) {
    return (
      <figure className="w-full max-w-md">
        {imageSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageSrc}
            alt={file.filename}
            className="max-w-full rounded-xl border border-gray-200 dark:border-gray-700"
          />
        ) : (
          <div className="h-48 w-full animate-pulse rounded-xl border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800" />
        )}
        <figcaption className="mt-1.5 flex items-center justify-between gap-2 text-xs text-gray-600 dark:text-gray-400">
          <span className="truncate">{file.filename}</span>
          {imageSrc && (
            <a
              href={imageSrc}
              download={file.filename}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1 font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <IconDownload size={14} aria-hidden="true" />
              {t('downloadFile')}
            </a>
          )}
        </figcaption>
      </figure>
    );
  }

  // Attachment-style card for documents/exports: extension badge, filename,
  // and an explicit Download button — the download must be obvious, not an
  // icon-only affordance.
  return (
    <div className="flex min-w-[220px] max-w-xs flex-col gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-2">
        <span
          className={`rounded-md px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-white ${badgeClassFor(extension)}`}
        >
          {extension || 'file'}
        </span>
      </div>
      <div className="break-words text-sm font-medium text-gray-900 dark:text-gray-100">
        {file.filename}
      </div>
      <a
        href={file.url}
        download={file.filename}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
      >
        <IconDownload size={16} aria-hidden="true" />
        {t('downloadFile')}
      </a>
    </div>
  );
};
