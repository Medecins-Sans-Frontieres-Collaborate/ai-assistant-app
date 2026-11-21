'use client';

import { useEffect, useState } from 'react';

import { fetchNativePdfImage } from '@/client/services/workflows/nativePdfTranslation';
import {
  RunImageLoader,
  RunImagePriority,
  createRunImageLoader,
} from '@/client/services/workflows/runImageLoader';

/**
 * The one loader of run page images in the app (see PAGE IMAGES in
 * runImageLoader.ts): every screen showing a page image shares its cache
 * and its queue.
 */
export const runImageLoader: RunImageLoader = createRunImageLoader((url) =>
  fetchNativePdfImage(url),
);

/**
 * A run's page image, loaded at `priority` (see PAGE IMAGES in
 * runImageLoader.ts).
 *
 * @param url - The image's `previewUrl` or `checkUrl`; none shows nothing.
 * @param priority - How soon it is needed.
 * @param enabled - False waits without loading (a thumbnail not yet near
 *   view); an image already loaded is still returned.
 * @returns The image, or null while it loads or when it could not be
 *   loaded (the screen shows a placeholder either way).
 */
export function useRunImage(
  url: string | undefined,
  priority: RunImagePriority,
  enabled = true,
): string | null {
  const [loaded, setLoaded] = useState<{ url: string; image: string } | null>(
    null,
  );
  const cached = url ? runImageLoader.peek(url) : undefined;

  useEffect(() => {
    if (!url || !enabled || runImageLoader.peek(url) !== undefined) return;
    let live = true;
    runImageLoader.load(url, priority).then(
      (image) => {
        if (live) setLoaded({ url, image });
      },
      // A page that cannot be loaded keeps its placeholder; the run's
      // storage notice explains a run that is gone or locked.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [url, priority, enabled]);

  return cached ?? (loaded && loaded.url === url ? loaded.image : null);
}

/**
 * Starts loading images nobody shows yet, so they are there when wanted.
 * Results are kept by the loader; nothing here re-renders.
 *
 * @param urls - Images to load, most wanted first.
 * @param priority - `soon` or `later` (see {@link RunImagePriority}).
 * @param enabled - False holds the loads back (e.g. until the page on
 *   screen has loaded, so they do not compete with it).
 */
export function usePrefetchRunImages(
  urls: readonly string[],
  priority: Exclude<RunImagePriority, 'now'>,
  enabled = true,
): void {
  // The list is compared by content: a new array of the same images
  // must not queue them again.
  const key = urls.join('\n');
  useEffect(() => {
    if (!enabled || !key) return;
    for (const url of key.split('\n')) {
      void runImageLoader.load(url, priority).catch(() => undefined);
    }
  }, [key, priority, enabled]);
}
