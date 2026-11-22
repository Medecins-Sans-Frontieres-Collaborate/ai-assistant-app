/**
 * Limits-panel additions to the admin class vocabulary
 * (components/Admin/adminClasses.ts).
 *
 * The warn chip now lives in adminClasses.ts as ADMIN_CHIP_WARN; the alias
 * below keeps the limits components' import name stable.
 */
import { ADMIN_CHIP_WARN } from '@/components/Admin/adminClasses';

/** Amber chip — a warning that is not an error (narrowed target, overlap). */
export const LIMITS_CHIP_WARN = ADMIN_CHIP_WARN;

/**
 * Informational card: the overlap hint, the cost notes and the "relevant
 * rules" popover. A blue tint and border all round set it apart from
 * ADMIN_CARD so it reads as a note rather than a record. The background is
 * opaque: the popover lies over other content.
 */
export const LIMITS_NOTE_CARD =
  'rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-gray-700 dark:border-blue-900 dark:bg-blue-950 dark:text-gray-300';
