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
 * Informational card — the overlap hint and the "relevant rules" popover.
 * Same surface as ADMIN_CARD, distinguished only by a blue left rule so it
 * reads as a note rather than a record.
 */
export const LIMITS_NOTE_CARD =
  'rounded-lg border border-gray-200 border-l-4 border-l-blue-400 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:border-l-blue-500 dark:bg-surface-dark dark:text-gray-300';
