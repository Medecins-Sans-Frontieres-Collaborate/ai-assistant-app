'use client';

import { RefObject, useEffect, useState } from 'react';

/** How far outside its scrolling list an element counts as near. */
export const NEAR_VIEW_MARGIN = '240px';

/**
 * Whether the element behind `holder` has come near the visible part of
 * its list (within `margin`). Once near, it stays near: a page picture is
 * made once and kept. Without the observer (an old browser) everything is
 * near.
 *
 * @param holder - The element to watch.
 * @param margin - How far outside the view still counts, as a CSS margin.
 */
export function useNearView(
  holder: RefObject<HTMLElement | null>,
  margin: string = NEAR_VIEW_MARGIN,
): boolean {
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === 'undefined',
  );
  useEffect(() => {
    if (near || !holder.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: margin },
    );
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [near, holder, margin]);
  return near;
}
