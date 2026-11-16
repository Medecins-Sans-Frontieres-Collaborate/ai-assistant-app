/**
 * Text direction as the browser resolved it for an element.
 *
 * Convention used across the UI: "start" is the edge reading begins at
 * (left in left-to-right documents, right in right-to-left ones) and "end"
 * is the opposite edge. Code that works in physical pixels (pointer
 * coordinates, getBoundingClientRect) asks these helpers which physical side
 * "start" is, rather than assuming left.
 */

/**
 * Whether an element lays its content out right to left. Reads the computed
 * style, so a `dir="ltr"` island inside a right-to-left page reports false.
 *
 * @param element - Any connected element; null/undefined falls back to the
 *   document root.
 * @returns True for right-to-left, false otherwise (including on the server).
 */
export function isRtlElement(element?: Element | null): boolean {
  if (typeof window === 'undefined') return false;
  const target = element ?? document.documentElement;
  return window.getComputedStyle(target).direction === 'rtl';
}

/**
 * Sign that turns "pixels moved to the right" into "pixels moved toward the
 * end edge": +1 in left-to-right layouts, -1 in right-to-left ones.
 *
 * @param element - Element whose direction decides the sign.
 * @returns 1 or -1.
 */
export function inlineEndSign(element?: Element | null): 1 | -1 {
  return isRtlElement(element) ? -1 : 1;
}

/** A physical horizontal side. */
export type PhysicalSide = 'left' | 'right';

/**
 * Mirrors a physical side for right-to-left layouts, so a component authored
 * with "right" meaning "toward the end edge" keeps that meaning.
 *
 * @param side - The side as authored for left-to-right.
 * @param rtl - Whether the layout is right to left.
 * @returns The side to use.
 */
export function mirrorSide(side: PhysicalSide, rtl: boolean): PhysicalSide {
  if (!rtl) return side;
  return side === 'left' ? 'right' : 'left';
}
