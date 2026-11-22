/**
 * The minified pdf.js builds ship without type declarations. They are the
 * builds the browser bundle can load (see
 * client/hooks/workflows/usePdfPages.ts).
 */
declare module 'pdfjs-dist/build/pdf.min.mjs' {
  export * from 'pdfjs-dist';
}

/** Imported only for its side effect of registering the worker. */
declare module 'pdfjs-dist/build/pdf.worker.min.mjs';
