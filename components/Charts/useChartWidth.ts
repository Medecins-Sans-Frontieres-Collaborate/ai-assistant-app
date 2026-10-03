'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The pixel width of a chart's container, so the chart is drawn at its real
 * size and text stays the size it was set — rather than scaling a fixed
 * viewBox, which shrinks labels on a narrow screen and inflates them on a
 * wide one.
 */
export function useChartWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measured = Math.round(element.getBoundingClientRect().width);
    if (measured > 0) setWidth(measured);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}
