/**
 * Geometry of a page shown on screen, for every feature that shows pages
 * (docs/DOCUMENT_PLATFORM.md): how far it is zoomed, and where a box given
 * in page points is drawn over its picture.
 *
 * COORDINATES are points from the page's top-left corner, as every format
 * adapter reports them.
 */

/** A page's size in points. */
export interface PageSize {
  width: number;
  height: number;
}

/**
 * ZOOM of the page view. 1 shows the page at its normal width (PAGE_WIDTH in
 * components/Documents/DocumentPage). The buttons and Ctrl/Cmd with +, - and 0 step through
 * PAGE_ZOOM_LEVELS; a pinch or Ctrl+wheel goes anywhere between the first
 * and the last.
 */
export const PAGE_ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5] as const;
export const DEFAULT_PAGE_ZOOM = 1;
export const MIN_PAGE_ZOOM = PAGE_ZOOM_LEVELS[0];
export const MAX_PAGE_ZOOM = PAGE_ZOOM_LEVELS[PAGE_ZOOM_LEVELS.length - 1];
/** Zoom levels closer than this are the same level (a pinch lands between). */
export const PAGE_ZOOM_EPSILON = 0.001;

/** A zoom level kept between MIN_PAGE_ZOOM and MAX_PAGE_ZOOM. */
export function clampPageZoom(zoom: number): number {
  return Math.min(MAX_PAGE_ZOOM, Math.max(MIN_PAGE_ZOOM, zoom));
}

/**
 * The zoom level one step in or out from the current one. A level between
 * two (after a pinch) steps to the next one in that direction.
 *
 * @param zoom - The current level.
 * @param direction - `1` to zoom in, `-1` to zoom out.
 * @returns The next level, or the current one at either end.
 */
export function nextPageZoom(zoom: number, direction: 1 | -1): number {
  const levels: readonly number[] = PAGE_ZOOM_LEVELS;
  if (direction > 0) {
    return (
      levels.find((level) => level > zoom + PAGE_ZOOM_EPSILON) ??
      levels[levels.length - 1]
    );
  }
  return (
    [...levels].reverse().find((level) => level < zoom - PAGE_ZOOM_EPSILON) ??
    levels[0]
  );
}

/** How much one pixel of wheel delta zooms (0.2% a pixel). */
const WHEEL_ZOOM_PER_PX = 0.002;

/**
 * The zoom level after a pinch or Ctrl+wheel: each unit of wheel delta
 * scales the page a little, so a trackpad pinch and a mouse wheel's notch
 * both feel proportionate. Negative delta (wheel up, fingers apart) zooms in.
 *
 * @param zoom - The current level.
 * @param deltaPx - The wheel's vertical delta, in pixels.
 */
export function wheelPageZoom(zoom: number, deltaPx: number): number {
  return clampPageZoom(zoom * Math.exp(-deltaPx * WHEEL_ZOOM_PER_PX));
}

/** A box as CSS percentages of its page. */
export interface PercentBox {
  left: string;
  top: string;
  width: string;
  height: string;
}

/** Points added around a unit's box so its outline does not touch the text. */
const BOX_PADDING_POINTS = 2;

/**
 * Where a box sits on its page, as percentages, so the outline scales with
 * the page image at any size.
 *
 * @param box - `[x0, y0, x1, y1]` in page points from the top-left corner.
 * @param page - The page's size in points.
 */
export function pageBox(
  box: [number, number, number, number],
  page: PageSize,
): PercentBox {
  const percent = (value: number, of: number) =>
    `${Math.min(Math.max((value / of) * 100, 0), 100).toFixed(3)}%`;
  const [x0, y0, x1, y1] = box;
  return {
    left: percent(x0 - BOX_PADDING_POINTS, page.width),
    top: percent(y0 - BOX_PADDING_POINTS, page.height),
    width: percent(x1 - x0 + 2 * BOX_PADDING_POINTS, page.width),
    height: percent(y1 - y0 + 2 * BOX_PADDING_POINTS, page.height),
  };
}
