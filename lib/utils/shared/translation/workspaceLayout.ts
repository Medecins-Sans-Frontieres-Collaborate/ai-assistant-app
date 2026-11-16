/**
 * How the translation workspace arranges itself for the width it actually
 * has.
 *
 * The workspace's width is not the window's: the app sidebar and the
 * conversation rail both take from it, so window breakpoints put the review
 * column beside panes that have no room for it. Every arrangement decision
 * is made here, from the measured width, and nowhere else.
 */

/** Narrowest workspace that fits source, translation and review in a row. */
export const REVIEW_BESIDE_MIN_WIDTH = 820;

/** Narrowest workspace that fits source and translation side by side. */
export const PANES_SIDE_BY_SIDE_MIN_WIDTH = 560;

export interface WorkspaceLayout {
  /** Review column sits beside the panes; otherwise it goes below them. */
  reviewBeside: boolean;
  /** Source and translation sit side by side; otherwise they stack. */
  panesSideBySide: boolean;
}

/**
 * Chooses the arrangement for a workspace of the given width.
 *
 * @param width - Measured workspace width in pixels.
 * @returns Which parts sit side by side at that width.
 */
export function workspaceLayout(width: number): WorkspaceLayout {
  return {
    reviewBeside: width >= REVIEW_BESIDE_MIN_WIDTH,
    panesSideBySide: width >= PANES_SIDE_BY_SIDE_MIN_WIDTH,
  };
}
