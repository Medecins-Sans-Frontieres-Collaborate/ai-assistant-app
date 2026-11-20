'use client';

import { RefObject, useEffect, useRef, useState } from 'react';

/** Pointer travel, in pixels, that turns a press into a drag. */
const DRAG_THRESHOLD_PX = 4;

/** Marks an element over the page that is never panned from (a toolbar). */
export const NO_PAN_ATTRIBUTE = 'data-no-pan';

/** Elements that keep their own pointer behaviour: they are never panned from. */
const INTERACTIVE = `button, a, input, textarea, select, label, [role="button"], [contenteditable="true"], [${NO_PAN_ATTRIBUTE}]`;

/**
 * Drags a zoomed page around with the mouse, like a hand tool: pressing on
 * the page (not on a block or a control) and moving scrolls the pane; a
 * press that does not move is a click on the empty page. Touch is left to
 * the browser, which already scrolls with a finger.
 *
 * @param scrollerRef - The pane that scrolls the page.
 * @param onEmptyClick - Called on a click on the page outside any block.
 * @param layoutKey - Changes when the pane's content is replaced or resized
 *   by the screen (another page, another zoom), to measure it again.
 * @returns Whether the pane can be panned now (its page is larger than it),
 *   for the cursor, and whether a drag is under way.
 */
export function usePagePan(
  scrollerRef: RefObject<HTMLElement | null>,
  onEmptyClick: () => void,
  layoutKey: string,
): { pannable: boolean; panning: boolean } {
  const [pannable, setPannable] = useState(false);
  const [panning, setPanning] = useState(false);
  const onEmptyClickRef = useRef(onEmptyClick);
  useEffect(() => {
    onEmptyClickRef.current = onEmptyClick;
  });

  // Whether there is anything to pan, kept as the pane or its page resize.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const measure = () =>
      setPannable(
        scroller.scrollWidth > scroller.clientWidth + 1 ||
          scroller.scrollHeight > scroller.clientHeight + 1,
      );
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    for (const child of Array.from(scroller.children)) observer.observe(child);
    measure();
    return () => observer.disconnect();
  }, [scrollerRef, layoutKey]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let press: {
      id: number;
      x: number;
      y: number;
      left: number;
      top: number;
      moved: boolean;
    } | null = null;
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      const target = event.target as Element | null;
      if (target?.closest(INTERACTIVE)) return;
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: scroller.scrollLeft,
        top: scroller.scrollTop,
        moved: false,
      };
    };
    const onMove = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.id) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        press.moved = true;
        scroller.setPointerCapture(press.id);
        setPanning(true);
      }
      scroller.scrollLeft = press.left - dx;
      scroller.scrollTop = press.top - dy;
    };
    const onUp = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.id) return;
      const clicked = !press.moved;
      if (scroller.hasPointerCapture(press.id)) {
        scroller.releasePointerCapture(press.id);
      }
      press = null;
      setPanning(false);
      if (clicked) onEmptyClickRef.current();
    };
    const onCancel = () => {
      press = null;
      setPanning(false);
    };
    scroller.addEventListener('pointerdown', onDown);
    scroller.addEventListener('pointermove', onMove);
    scroller.addEventListener('pointerup', onUp);
    scroller.addEventListener('pointercancel', onCancel);
    return () => {
      scroller.removeEventListener('pointerdown', onDown);
      scroller.removeEventListener('pointermove', onMove);
      scroller.removeEventListener('pointerup', onUp);
      scroller.removeEventListener('pointercancel', onCancel);
    };
  }, [scrollerRef]);

  return { pannable, panning };
}
