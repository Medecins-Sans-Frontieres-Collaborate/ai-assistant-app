'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { PageSize } from '@/lib/utils/shared/documents/pageGeometry';

/** Loading state of the document behind {@link usePdfPages}. */
export type PdfPagesStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface PdfPages {
  /**
   * `idle` before loading starts: with no file, or, on demand, until a page
   * is first rendered.
   */
  status: PdfPagesStatus;
  /** Pages in the document; 0 until it is ready. */
  pageCount: number;
  /**
   * Renders one page to an image, loading the document first when it is
   * not loaded yet.
   *
   * @param page - 1-based page number.
   * @param width - Width of the image in CSS pixels.
   * @returns A data URL, or null when the page cannot be rendered (or the
   *   document cannot be opened, or it was unloaded meanwhile).
   */
  renderPage: (page: number, width: number) => Promise<string | null>;
  /**
   * A page's size in points (PDF units, 72 to the inch), loading the
   * document first when needed: what boxes over the page are given in.
   *
   * @returns The size, or null when the page or the document cannot be read.
   */
  pageSize: (page: number) => Promise<PageSize | null>;
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
 * A screen that may never show the original (the review of a translated
 * document) asks for it on demand: the file is fetched and opened on the
 * first rendered page, not when the screen opens. A long document is
 * several megabytes, and opening it competes with what the screen does
 * need first.
 *
 * @param loadFile - Returns the PDF; called once per `fileKey`.
 * @param fileKey - Identifies the file. A new key loads a new document;
 *   null unloads.
 * @param options.onDemand - Load on the first rendered page instead of at
 *   once. Turning it off loads a document not loaded yet.
 */
export function usePdfPages(
  loadFile: () => Promise<Blob>,
  fileKey: string | null,
  options: { onDemand?: boolean } = {},
): PdfPages {
  const onDemand = options.onDemand ?? false;
  const [status, setStatus] = useState<PdfPagesStatus>('idle');
  const [pageCount, setPageCount] = useState(0);
  const documentRef = useRef<LoadedDocument | null>(null);
  const cacheRef = useRef(new Map<string, Promise<string | null>>());
  const loadFileRef = useRef(loadFile);
  // Kept in step in layout effects: those run before any passive effect, so
  // a child that renders a page in its own effect already sees the new file.
  useLayoutEffect(() => {
    loadFileRef.current = loadFile;
  });
  /**
   * The document of the current key, loading or loaded; null before the
   * first request. Each key has its own `generation`, so a load that
   * finishes after its key was replaced is discarded.
   */
  const openingRef = useRef<{
    generation: number;
    promise: Promise<LoadedDocument | null>;
  } | null>(null);
  const generationRef = useRef(0);
  const fileKeyRef = useRef(fileKey);

  /** Starts loading the current key's document, once; resolves null on failure. */
  const ensureOpened = useCallback((): Promise<LoadedDocument | null> => {
    if (!fileKeyRef.current) return Promise.resolve(null);
    const generation = generationRef.current;
    if (openingRef.current?.generation === generation) {
      return openingRef.current.promise;
    }
    const isCurrent = () => generationRef.current === generation;
    setStatus('loading');
    const promise = (async (): Promise<LoadedDocument | null> => {
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
        if (!isCurrent()) {
          void loaded.destroy();
          return null;
        }
        documentRef.current = loaded;
        setPageCount(loaded.numPages);
        setStatus('ready');
        return loaded;
      } catch (error) {
        if (!isCurrent()) return null;
        console.warn('[usePdfPages] The PDF could not be opened:', error);
        setStatus('failed');
        return null;
      }
    })();
    openingRef.current = { generation, promise };
    return promise;
  }, []);

  useLayoutEffect(() => {
    fileKeyRef.current = fileKey;
    if (!fileKey) return;
    const cache = cacheRef.current;
    return () => {
      generationRef.current += 1;
      openingRef.current = null;
      cache.clear();
      void documentRef.current?.destroy();
      documentRef.current = null;
      setPageCount(0);
      setStatus('idle');
    };
  }, [fileKey]);

  useEffect(() => {
    if (fileKey && !onDemand) void ensureOpened();
  }, [fileKey, onDemand, ensureOpened]);

  const renderPage = useCallback(
    async (page: number, width: number): Promise<string | null> => {
      const loaded = documentRef.current ?? (await ensureOpened());
      if (!loaded || page < 1 || page > loaded.numPages) return null;
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
    [ensureOpened],
  );

  const pageSize = useCallback(
    async (page: number): Promise<PageSize | null> => {
      const loaded = documentRef.current ?? (await ensureOpened());
      if (!loaded || page < 1 || page > loaded.numPages) return null;
      try {
        const { width, height } = (await loaded.getPage(page)).getViewport({
          scale: 1,
        });
        return { width, height };
      } catch (error) {
        console.warn(
          `[usePdfPages] Page ${page} could not be measured:`,
          error,
        );
        return null;
      }
    },
    [ensureOpened],
  );

  return { status, pageCount, renderPage, pageSize };
}
