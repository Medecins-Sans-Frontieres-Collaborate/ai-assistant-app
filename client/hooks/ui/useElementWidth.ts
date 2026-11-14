'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Tracks the pixel width of an element, for layout that depends on the room
 * a component really has rather than on the window.
 *
 * @param fallback - Width reported until the element has been measured, and
 *   while it measures zero (not rendered, or hidden with CSS).
 * @returns `ref`, a callback ref for the element to measure, and its `width`.
 *
 * @example
 * const { ref, width } = useElementWidth<HTMLDivElement>(1200);
 * return <div ref={ref}>{width >= 800 ? <Wide /> : <Narrow />}</div>;
 */
export function useElementWidth<T extends HTMLElement>(fallback: number) {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  const ref = useCallback((node: T | null) => setElement(node), []);

  useEffect(() => {
    // An observer reports the size once on observing, so no separate first
    // measurement is needed; without one the fallback stands.
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { ref, width };
}
