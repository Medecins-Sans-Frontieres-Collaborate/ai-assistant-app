'use client';

import { useCallback, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { fetchDocumentPdf } from '@/client/services/documents/documentPdf';

import {
  BrandFinding,
  BrandFindingSeverity,
} from '@/lib/utils/shared/brand/brandFindings';
import { describeFinding } from '@/lib/utils/shared/brand/brandReport';

import {
  PageOverlay,
  PageOverlayTone,
} from '@/components/Documents/DocumentPage';
import {
  DocumentViewer,
  ViewerSource,
} from '@/components/Documents/DocumentViewer';

import { BrandFindingsPanel } from './BrandFindingsPanel';

const TONE: Record<BrandFindingSeverity, PageOverlayTone> = {
  error: 'error',
  warning: 'warning',
  info: 'normal',
};

/** Presentation types, whose pages are called slides. */
const SLIDE_TYPES = new Set([
  'pptx',
  'pptm',
  'ppsx',
  'potx',
  'ppt',
  'pps',
  'pot',
  'odp',
]);

const UPLOAD_REF = /^\/api\/file\/([a-f0-9]{64}\.[a-z0-9]+)$/;

/** A document the person uploaded (or a feature kept as their upload). */
export interface FindingsDocument {
  /** `/api/file/<sha256>.<ext>`. */
  file: string;
  name: string;
  type: string;
}

/**
 * A document's pages with brand findings drawn over them, and the
 * findings listed beside (filterable). Choosing a finding in either place
 * shows it on its page. Key it by the review, so a new review starts on
 * the first page with nothing chosen.
 */
export function BrandFindingsViewer({
  document,
  findings,
}: {
  document: FindingsDocument;
  findings: readonly BrandFinding[];
}) {
  const t = useTranslations('workflows.brandReview');
  const [selected, setSelected] = useState<BrandFinding | null>(null);
  const [page, setPage] = useState(1);

  const translate = useCallback(
    (key: string, values?: Record<string, string | number>) =>
      t(key as never, values as never),
    [t],
  );

  const sources = useMemo<[ViewerSource] | null>(() => {
    const upload = UPLOAD_REF.exec(document.file);
    if (!upload) return null;
    return [
      {
        key: document.file,
        label: document.name,
        load: () =>
          fetchDocumentPdf({
            kind: 'upload',
            id: upload[1],
            type: document.type,
          }),
      },
    ];
  }, [document.file, document.name, document.type]);

  const overlaysOf = useCallback(
    (pageNumber: number): PageOverlay[] =>
      findings
        .filter((finding) => finding.page === pageNumber && finding.box)
        .map((finding) => ({
          id: finding.id,
          box: finding.box!,
          tone: TONE[finding.severity],
          label: `${t(`rule.${finding.rule}`)}: ${describeFinding(finding, translate)}`,
        })),
    [findings, t, translate],
  );

  const findingsOn = useMemo(() => {
    const counts = new Map<number, number>();
    for (const finding of findings) {
      if (finding.page !== null) {
        counts.set(finding.page, (counts.get(finding.page) ?? 0) + 1);
      }
    }
    return counts;
  }, [findings]);

  if (!sources) return null;
  return (
    <DocumentViewer
      sources={sources}
      unit={SLIDE_TYPES.has(document.type) ? 'slide' : 'page'}
      overlaysOf={overlaysOf}
      selectedOverlayId={selected?.id ?? null}
      onSelectOverlay={(id) =>
        setSelected(findings.find((finding) => finding.id === id) ?? null)
      }
      page={page}
      onPageChange={setPage}
      pageBadge={(pageNumber) =>
        findingsOn.get(pageNumber) ? (
          <span className="rounded-full bg-gray-900/80 px-1.5 text-[11px] font-medium text-white">
            {findingsOn.get(pageNumber)}
          </span>
        ) : null
      }
      aside={
        <BrandFindingsPanel
          findings={findings}
          selectedId={selected?.id ?? null}
          onSelect={(finding) => {
            setSelected(finding);
            if (finding.page !== null) setPage(finding.page);
          }}
        />
      }
    />
  );
}
