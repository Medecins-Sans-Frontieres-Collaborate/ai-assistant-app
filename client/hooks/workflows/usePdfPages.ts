'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Loading state of the document behind {@link usePdfPages}. */
export type PdfPagesStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface PdfPages {
  status: PdfPagesStatus;
  /** Pages in the document; 0 until it is ready. */
  pageCount: number;
  /**
   * Renders one page to an image.
   *
   * @param page - 1-based page number.
   * @param width - Width of the image in CSS pixels.
   * @returns A data URL, or null when the page cannot be rendered.
   */
  renderPage: (page: number, width: number) => Promise<string | null>;
}

interface LoadedDocument {
  numPages: number;
  getPage: (page: number) => Promise<{
    getViewport: (options: { scale: number }) => {
      width: number;
      height: number;
    };
    render: (options: Record<string, unknown>) => { promise: Promise<void> };
  }>;
  destroy: () => Promise<void>;
}

/**
 * Renders pages of a PDF in the browser, for previews of the original
 * document. The renderer is loaded only when a file is given, and a file
 * that cannot be opened reports `failed` instead of throwing, so previews
 * are always optional to the screen using them.
 *
 * @param loadFile - Returns the PDF; called once per `fileKey`.
 * @param fileKey - Identifies the file. A new key loads a new document;
 *   null unloads.
 */
export function usePdfPages(
  loadFile: () => Promise<Blob>,
  fileKey: string | null,
): PdfPages {
  const [status, setStatus] = useState<PdfPagesStatus>('idle');
  const [pageCount, setPageCount] = useState(0);
  const documentRef = useRef<LoadedDocument | null>(null);
  const cacheRef = useRef(new Map<string, Promise<string | null>>());
  const loadFileRef = useRef(loadFile);
  useEffect(() => {
    loadFileRef.current = loadFile;
  });

  useEffect(() => {
    if (!fileKey) return;
    let cancelled = false;
    const cache = cacheRef.current;
    setStatus('loading');
    void (async () => {
      try {
        // Both modules are the minified builds, imported rather than
        // referenced by URL. The readable builds declare their own
        // `__webpack_exports__`, which shadows the bundler's and breaks the
        // module on load; the minified ones do not. The worker cannot be
        // emitted as a separate file by this build, so it is imported too:
        // it registers itself on `globalThis.pdfjsWorker` and pdf.js then
        // runs it on the main thread, which is fine for page previews.
        const [pdfjs, file] = await Promise.all([
          import('pdfjs-dist/build/pdf.min.mjs'),
          loadFileRef.current(),
          import('pdfjs-dist/build/pdf.worker.min.mjs'),
        ]);
        const loaded = (await pdfjs.getDocument({
          data: new Uint8Array(await file.arrayBuffer()),
        }).promise) as unknown as LoadedDocument;
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        documentRef.current = loaded;
        setPageCount(loaded.numPages);
        setStatus('ready');
      } catch (error) {
        if (cancelled) return;
        console.warn('[usePdfPages] The PDF could not be opened:', error);
        setStatus('failed');
      }
    })();
    return () => {
      cancelled = true;
      cache.clear();
      void documentRef.current?.destroy();
      documentRef.current = null;
      setPageCount(0);
      setStatus('idle');
    };
  }, [fileKey]);

  const renderPage = useCallback(
    (page: number, width: number): Promise<string | null> => {
      const loaded = documentRef.current;
      if (!loaded || page < 1 || page > loaded.numPages) {
        return Promise.resolve(null);
      }
      const key = `${page}@${width}`;
      const cached = cacheRef.current.get(key);
      if (cached) return cached;
      const rendering = (async () => {
        try {
          const pdfPage = await loaded.getPage(page);
          const base = pdfPage.getViewport({ scale: 1 });
          // Rendered at the device's pixel density so text stays sharp.
          const density = Math.min(window.devicePixelRatio || 1, 2);
          const viewport = pdfPage.getViewport({
            scale: (width / base.width) * density,
          });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await pdfPage.render({
            canvas,
            canvasContext: canvas.getContext('2d'),
            viewport,
          }).promise;
          return canvas.toDataURL('image/jpeg', 0.85);
        } catch (error) {
          console.warn(`[usePdfPages] Page ${page} did not render:`, error);
          return null;
        }
      })();
      cacheRef.current.set(key, rendering);
      return rendering;
    },
    [],
  );

  return { status, pageCount, renderPage };
}
