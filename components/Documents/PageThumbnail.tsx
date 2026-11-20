'use client';

import { RefObject, useEffect, useRef, useState } from 'react';

import { useNearView } from '@/client/hooks/documents/useNearView';
import { PdfPages } from '@/client/hooks/documents/usePdfPages';

/** Width a page is rendered at for its thumbnail, in CSS pixels. */
export const THUMBNAIL_WIDTH = 176;

/** Placeholder of a thumbnail that is not there yet. */
export function ThumbnailPlaceholder({
  holder,
  pulse,
}: {
  holder?: RefObject<HTMLSpanElement | null>;
  pulse: boolean;
}) {
  return (
    <span
      ref={holder}
      className={`block aspect-[210/297] w-full rounded-sm bg-gray-200 dark:bg-surface-dark-elevated ${
        pulse ? 'animate-pulse' : ''
      }`}
    />
  );
}

interface PdfPageThumbnailProps {
  /** 1-based page of the document. */
  page: number;
  pdf: PdfPages;
  /** Extra classes of the picture (how the page's state looks). */
  className?: string;
}

/**
 * A page of a document, rendered only once it is near the visible part of
 * its list: a long document has many pages that are never looked at. The
 * document itself loads on the first such page (see usePdfPages). The
 * picture is decorative: the list item around it names the page.
 */
export function PdfPageThumbnail({
  page,
  pdf,
  className = '',
}: PdfPageThumbnailProps) {
  const holder = useRef<HTMLSpanElement>(null);
  const near = useNearView(holder);
  const [image, setImage] = useState<string | null>(null);
  const { renderPage, status } = pdf;

  useEffect(() => {
    if (!near || status === 'failed') return;
    let cancelled = false;
    void renderPage(page, THUMBNAIL_WIDTH).then((url) => {
      if (!cancelled) setImage(url);
    });
    return () => {
      cancelled = true;
    };
  }, [near, status, renderPage, page]);

  return image ? (
    // A rendered page of the person's own document, as a data URL.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="" className={`w-full rounded-sm ${className}`} />
  ) : (
    <ThumbnailPlaceholder holder={holder} pulse={status !== 'failed'} />
  );
}
