'use client';

import { IconDownload } from '@tabler/icons-react';
import { FC, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import Modal from '@/components/UI/Modal';

import { FilePagePreview } from '@/lib/constants/filePreview';

/** What the viewer needs to know about the file it shows. */
export interface PreviewableFile {
  /** App file URL: `/api/file/<id>.<ext>`. */
  url: string;
  filename: string;
  /**
   * An already-loaded picture (data URL). When set, the viewer shows it
   * enlarged and asks the server for nothing; otherwise the file's pages
   * are rendered by `/api/file/<id>/preview`.
   */
  imageSrc?: string;
}

interface FilePreviewModalProps {
  /** The file to show; `null` keeps the viewer closed. */
  file: PreviewableFile | null;
  onClose: () => void;
}

type PageState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; preview: FilePagePreview };

/**
 * Fetches the rendered pages of a stored document.
 *
 * @param fileUrl - App file URL (`/api/file/<id>.<ext>`).
 * @param signal - Aborts the request when the viewer closes.
 * @returns The pages and the document's total page count.
 * @throws Error when the server cannot produce a preview.
 */
async function fetchPagePreview(
  fileUrl: string,
  signal: AbortSignal,
): Promise<FilePagePreview> {
  const fileId = fileUrl.split(/[?#]/)[0].split('/').pop();
  const response = await fetch(`/api/file/${fileId}/preview`, { signal });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data?.pages?.length) {
    throw new Error(`Preview failed with status ${response.status}`);
  }
  return body.data as FilePagePreview;
}

/** The pages of one document, loaded on mount. */
const DocumentPages: FC<{ file: PreviewableFile }> = ({ file }) => {
  const t = useTranslations('filePreview');
  const [state, setState] = useState<PageState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchPagePreview(file.url, controller.signal)
      .then((preview) => setState({ status: 'ready', preview }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      });
    return () => controller.abort();
  }, [file.url]);

  if (state.status === 'loading') {
    return (
      <div role="status" className="flex flex-col items-center gap-4 py-10">
        <div className="h-64 w-full max-w-md animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('loading')}
        </p>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <p
        role="alert"
        className="py-10 text-center text-sm text-gray-700 dark:text-gray-300"
      >
        {t('failed')}
      </p>
    );
  }

  const { pages, totalPages } = state.preview;
  return (
    <div className="flex flex-col items-center gap-4">
      {pages.map((page, index) => (
        <figure key={index} className="w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={page}
            alt={t('pageOf', { page: index + 1, total: totalPages })}
            className="mx-auto max-w-full rounded border border-gray-200 bg-white shadow-sm dark:border-gray-700"
          />
          <figcaption className="mt-1 text-center text-xs text-gray-500 dark:text-gray-400">
            {t('pageOf', { page: index + 1, total: totalPages })}
          </figcaption>
        </figure>
      ))}
      {totalPages > pages.length && (
        <p className="pb-2 text-center text-sm text-gray-600 dark:text-gray-400">
          {t('truncated', { shown: pages.length, total: totalPages })}
        </p>
      )}
    </div>
  );
};

/**
 * Viewer for a file attached to or produced in a conversation: a picture is
 * shown enlarged, a document as its rendered pages. Opening it never
 * downloads the file; the footer offers the download.
 */
export const FilePreviewModal: FC<FilePreviewModalProps> = ({
  file,
  onClose,
}) => {
  const t = useTranslations('filePreview');
  if (!file) return null;

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="xl"
      closeWithButton={false}
      title={
        <h3
          dir="auto"
          className="break-all text-base font-semibold text-gray-800 dark:text-white"
        >
          {file.filename}
        </h3>
      }
      footer={
        <a
          href={file.imageSrc ?? file.url}
          download={file.filename}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          <IconDownload size={16} aria-hidden="true" />
          {t('download')}
        </a>
      }
    >
      <div className="max-h-[70vh] overflow-y-auto rounded-lg bg-gray-100 p-3 dark:bg-gray-900">
        {file.imageSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={file.imageSrc}
            alt={file.filename}
            className="mx-auto max-w-full rounded"
          />
        ) : (
          <DocumentPages key={file.url} file={file} />
        )}
      </div>
    </Modal>
  );
};
