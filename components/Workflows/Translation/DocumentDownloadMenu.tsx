'use client';

import { IconChevronDown, IconDownload } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  downloadFile,
  textVersionUrl,
  translatedFileUrl,
} from '@/client/services/workflows/documentTranslationJob';

import { textVersionFilename } from '@/types/documentTranslation';
import { TranslationDocumentJob } from '@/types/workflow';

interface DocumentDownloadMenuProps {
  job: TranslationDocumentJob;
}

type DownloadKind = 'translated' | 'text';

/**
 * The two files a whole-document translation produces: the translated
 * document in its original layout, and the text version (DOCX), which is
 * the one that carries the user's page corrections.
 */
export function DocumentDownloadMenu({ job }: DocumentDownloadMenuProps) {
  const t = useTranslations('workflows');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<DownloadKind | null>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false);
      } else if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const download = async (kind: DownloadKind) => {
    setOpen(false);
    setBusy(kind);
    try {
      if (kind === 'translated') {
        await downloadFile(
          translatedFileUrl(
            job.jobId,
            job.translatedFilename,
            job.fileExtension,
          ),
          job.translatedFilename,
        );
      } else {
        await downloadFile(
          textVersionUrl(job.jobId),
          textVersionFilename(job.translatedFilename),
        );
      }
    } catch (error) {
      toast.error(
        t('translation.downloadFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  const items: { kind: DownloadKind; label: string; hint: string }[] = [
    {
      kind: 'translated',
      label: t('translation.downloadTranslated', {
        format: job.fileExtension.toUpperCase(),
      }),
      hint: t('translation.downloadTranslatedHint'),
    },
    {
      kind: 'text',
      label: t('translation.downloadTextVersion'),
      hint: t('translation.downloadTextVersionHint'),
    },
  ];

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((shown) => !shown)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy !== null}
        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
      >
        <IconDownload size={13} aria-hidden />
        {busy ? t('translation.downloading') : t('translation.download')}
        <IconChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute end-0 z-20 mt-1 w-72 rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-surface-dark-elevated"
        >
          {items.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              onClick={() => void download(item.kind)}
              className="block w-full rounded-md px-2.5 py-1.5 text-start hover:bg-gray-100 dark:hover:bg-surface-dark"
            >
              <span className="block text-sm text-gray-900 dark:text-gray-100">
                {item.label}
              </span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                {item.hint}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
