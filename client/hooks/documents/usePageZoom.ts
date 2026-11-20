'use client';

import {
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { ownsKeyboard } from '@/lib/utils/client/keyboardScope';
import {
  DEFAULT_PAGE_ZOOM,
  MAX_PAGE_ZOOM,
  MIN_PAGE_ZOOM,
  PAGE_ZOOM_EPSILON,
  clampPageZoom,
  nextPageZoom,
  wheelPageZoom,
} from '@/lib/utils/shared/documents/pageGeometry';

/** Marks the element that is the page, inside the scroller (see anchors). */
export const PAGE_SURFACE_ATTRIBUTE = 'data-page-surface';

/** Pixels in one wheel "line" (`deltaMode` 1), as browsers scroll them. */
const WHEEL_LINE_PX = 16;

/** A point on screen that stays on the same spot of the page while zooming. */
interface Anchor {
  clientX: number;
  clientY: number;
  /** Where the point is on the page, as a share of its width and height. */
  fx: number;
  fy: number;
}

export interface PageZoom {
  zoom: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  /** One step in (`1`) or out (`-1`), about the middle of the view. */
  step: (direction: 1 | -1) => void;
  /** Back to the normal size, about the middle of the view. */
  reset: () => void;
}

/**
 * ZOOM (formattedDocument.ts) of a page in a scrolling pane, by every means
 * a person expects:
 *  - the zoom buttons, and Ctrl (Cmd on macOS) with +, - or 0 while the
 *    screen has the keyboard: the page zooms, not the browser;
 *  - Ctrl+wheel and a trackpad pinch over the pane (Safari's pinch too),
 *    which zoom smoothly between the levels.
 * The point under the pointer, or the middle of the view, stays where it is
 * on screen, so zooming never loses the place being read.
 *
 * @param scrollerRef - The pane that scrolls the page; it holds one element
 *   marked PAGE_SURFACE_ATTRIBUTE, the page.
 * @param rootRef - The screen whose keyboard the keys belong to (see
 *   ownsKeyboard).
 */
export function usePageZoom(
  scrollerRef: RefObject<HTMLElement | null>,
  rootRef: RefObject<HTMLElement | null>,
): PageZoom {
  const [zoom, setZoom] = useState(DEFAULT_PAGE_ZOOM);
  const zoomRef = useRef(zoom);
  const anchorRef = useRef<Anchor | null>(null);

  /** Zooms to `next`, keeping the point at `at` (default: the view's middle) still. */
  const zoomTo = useCallback(
    (next: number, at?: { clientX: number; clientY: number }) => {
      const level = clampPageZoom(next);
      if (Math.abs(level - zoomRef.current) < PAGE_ZOOM_EPSILON) return;
      const scroller = scrollerRef.current;
      const surface = scroller?.querySelector(`[${PAGE_SURFACE_ATTRIBUTE}]`);
      if (scroller && surface) {
        const view = scroller.getBoundingClientRect();
        const page = surface.getBoundingClientRect();
        const clientX = at?.clientX ?? view.left + view.width / 2;
        const clientY = at?.clientY ?? view.top + view.height / 2;
        anchorRef.current = {
          clientX,
          clientY,
          fx: page.width ? (clientX - page.left) / page.width : 0,
          fy: page.height ? (clientY - page.top) / page.height : 0,
        };
      }
      zoomRef.current = level;
      setZoom(level);
    },
    [scrollerRef],
  );

  // Once the page has its new size, scroll so the anchor is where it was.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const scroller = scrollerRef.current;
    const surface = scroller?.querySelector(`[${PAGE_SURFACE_ATTRIBUTE}]`);
    if (!anchor || !scroller || !surface) return;
    const page = surface.getBoundingClientRect();
    scroller.scrollLeft += page.left + anchor.fx * page.width - anchor.clientX;
    scroller.scrollTop += page.top + anchor.fy * page.height - anchor.clientY;
  }, [zoom, scrollerRef]);

  // Ctrl+wheel and pinches. The listener is not passive: the browser's own
  // zoom of the whole app is what preventDefault stops.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? WHEEL_LINE_PX
          : event.deltaMode === 2
            ? scroller.clientHeight
            : 1;
      zoomTo(wheelPageZoom(zoomRef.current, event.deltaY * unit), event);
    };
    // Safari reports a trackpad pinch as gesture events, with a scale.
    let gestureStart = zoomRef.current;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStart = zoomRef.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & {
        scale: number;
        clientX: number;
        clientY: number;
      };
      zoomTo(gestureStart * gesture.scale, gesture);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    scroller.addEventListener('gesturestart', onGestureStart);
    scroller.addEventListener('gesturechange', onGestureChange);
    return () => {
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('gesturestart', onGestureStart);
      scroller.removeEventListener('gesturechange', onGestureChange);
    };
  }, [scrollerRef, zoomTo]);

  // Ctrl/Cmd with +, - and 0, while the screen has the keyboard.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (!ownsKeyboard(rootRef.current)) return;
      const key = event.key;
      const zoomIn = key === '=' || key === '+' || event.code === 'NumpadAdd';
      const zoomOut =
        key === '-' || key === '_' || event.code === 'NumpadSubtract';
      const reset = key === '0' || event.code === 'Numpad0';
      if (!zoomIn && !zoomOut && !reset) return;
      event.preventDefault();
      if (reset) zoomTo(DEFAULT_PAGE_ZOOM);
      else zoomTo(nextPageZoom(zoomRef.current, zoomIn ? 1 : -1));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rootRef, zoomTo]);

  return {
    zoom,
    canZoomIn: zoom < MAX_PAGE_ZOOM - PAGE_ZOOM_EPSILON,
    canZoomOut: zoom > MIN_PAGE_ZOOM + PAGE_ZOOM_EPSILON,
    step: (direction) => zoomTo(nextPageZoom(zoomRef.current, direction)),
    reset: () => zoomTo(DEFAULT_PAGE_ZOOM),
  };
}
