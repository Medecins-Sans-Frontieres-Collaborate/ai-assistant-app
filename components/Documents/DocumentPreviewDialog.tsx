'use client';

import { useMemo } from 'react';

import { fetchDocumentPdf } from '@/client/services/documents/documentPdf';

import {
  DocumentSource,
  documentUnitOf,
} from '@/lib/utils/shared/documents/documentSource';

import Modal from '@/components/UI/Modal';

import { DocumentViewer, ViewerSource } from './DocumentViewer';

/** A version of the document to preview, and its name in the switch. */
export interface PreviewVersion {
  source: DocumentSource;
  label: string;
}

interface DocumentPreviewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The dialog's title: the document's name. */
  title: string;
  /**
   * What to show: one version, or two shown one at a time (a translation
   * and its original). The first is shown first.
   */
  versions: [PreviewVersion] | [PreviewVersion, PreviewVersion];
}

/**
 * Any document the app holds (THE DOCUMENT SOURCE), opened as pages in a
 * dialog over the screen: a presentation's pages are called slides.
 */
export function DocumentPreviewDialog({
  isOpen,
  onClose,
  title,
  versions,
}: DocumentPreviewDialogProps) {
  const sources = useMemo(
    () =>
      versions.map(
        (version): ViewerSource => ({
          key: `${version.source.kind}:${version.source.id}:${version.source.type}`,
          label: version.label,
          load: () => fetchDocumentPdf(version.source),
        }),
      ) as [ViewerSource] | [ViewerSource, ViewerSource],
    [versions],
  );
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="full"
      className="!max-w-6xl !p-0 flex h-[92vh] flex-col overflow-hidden"
      headerClassName="!mb-0 border-b border-gray-200 px-4 py-3 dark:border-gray-700"
      contentClassName="min-h-0 flex-1"
    >
      {isOpen && (
        <DocumentViewer
          sources={sources}
          unit={documentUnitOf(versions[0].source.type)}
        />
      )}
    </Modal>
  );
}
