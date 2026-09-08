/**
 * The class vocabulary for admin surfaces.
 *
 * Named rather than inlined so every admin control resolves its light/dark
 * pairing in ONE place. `__tests__/design/adminSurfaceTokens.test.ts` asserts
 * that any admin file rendering a form control imports from here, which is a
 * positive invariant a new wrong colour cannot slip past.
 *
 * Layout (widths, flex, margins) stays inline at the call site — only the
 * surface and control layer is named. Mixing layout in here would produce a
 * component library by accident.
 *
 * Plane order in dark mode is deliberate and load-bearing:
 *   page  #171717  surface-dark-base   ← AdminShell
 *   card  #212121  surface-dark        ← ADMIN_CARD / ADMIN_ROW
 *   field #1f2937  gray-800            ← ADMIN_FIELD (recessed inside a card)
 * A field must stay visually recessed relative to the card it sits in; that is
 * why cards use surface-dark rather than RuleEditor's `dark:bg-gray-800/50`,
 * which would put a gray-800 field on a gray-800-ish card.
 */

/** A grouping container: the policy card, an override record. */
export const ADMIN_CARD =
  'rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-surface-dark';

/** A single row inside a section — one limit, one setting. */
export const ADMIN_ROW =
  'rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-surface-dark';

/**
 * Every text input, number input and select in the admin area.
 *
 * Three declarations here are load-bearing against app/globals.css, which
 * styles the bare `select` element app-wide (lines ~186-200):
 *  - `m-0` cancels its `margin: 0 5px`, which otherwise fights every gap-2.
 *  - explicit `text-black dark:text-white` stops the glyph colour depending on
 *    the `.dark select { color: #fff }` rule.
 *  - `focus-visible:ring-2` restores the focus indicator its `outline: none`
 *    strips. Before this, `grep -rn focus components/Limits/` returned nothing:
 *    no control in the limits admin had a visible focus state at all (WCAG
 *    2.4.7, and PRODUCT.md targets AAA).
 * Fixing globals.css itself is the real cure but its blast radius covers every
 * select in the app; that is a separate, separately-verifiable change.
 */
export const ADMIN_FIELD =
  'm-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-black placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-500';

export const ADMIN_CHECKBOX =
  'h-4 w-4 accent-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:accent-gray-400';

export const ADMIN_BTN_PRIMARY =
  'rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50';

export const ADMIN_BTN_SECONDARY =
  'flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-black transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800';

/** Retry after an error. Neutral on purpose — retrying is not destructive. */
export const ADMIN_BTN_RETRY =
  'rounded-md border border-gray-300 px-3 py-1 text-sm text-black transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:text-white dark:hover:bg-gray-800';

/** Icon-only destructive action (remove a row). */
export const ADMIN_BTN_ICON_DANGER =
  'rounded p-1 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400 dark:hover:bg-red-900/20 dark:hover:text-red-400';

export const ADMIN_BANNER_WARN =
  'rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300';

export const ADMIN_BANNER_ERROR =
  'rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300';

export const ADMIN_CHIP_DANGER =
  'rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-300';

/** Amber chip — a warning that is not an error (narrowed target, overlap). */
export const ADMIN_CHIP_WARN =
  'rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300';

/**
 * Per-chip emphasis RINGS for `ChipListInput` (components/AgentAccess), which
 * the limits editors reuse for targets and admins: danger = a target the
 * server refused, warn = one that needs a second look. Rings rather than
 * fills because the chip keeps its neutral body; only the outline speaks.
 */
export const ADMIN_CHIP_RING_DANGER = 'ring-1 ring-red-500 dark:ring-red-400';

export const ADMIN_CHIP_RING_WARN = 'ring-1 ring-amber-500 dark:ring-amber-400';

/** Neutral chip — a qualifier badge, a scope marker. */
export const ADMIN_CHIP_NEUTRAL =
  'rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300';

export const ADMIN_LABEL =
  'mb-1 block text-sm font-medium text-black dark:text-white';

export const ADMIN_HINT = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

/** A group heading inside a page body. */
export const ADMIN_HEADING =
  'mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300';

/** Muted body copy — descriptions, secondary detail. */
export const ADMIN_MUTED = 'text-xs text-gray-500 dark:text-gray-400';
