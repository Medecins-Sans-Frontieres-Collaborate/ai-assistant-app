/**
 * Queue-level helpers for the suggested-edit list: what stays visible after
 * a decision, and what a decision looks like undone. Text application
 * itself lives in editApplication.ts.
 */
import { ReviewEditStatus } from '@/types/workflow';

import { EditPatch } from './editApplication';

/** Anything that was decided — the greyed record below the live queue. */
export function isResolved(status: ReviewEditStatus): boolean {
  return status !== 'pending';
}

interface PruneOptions {
  /**
   * Keep edits that could not be applied. Auto-clear sets this: an edit
   * that silently failed to land is exactly the one the user still needs
   * to see, so it must never be swept away without being asked for.
   */
  keepUnapplicable?: boolean;
}

/** Drops decided edits from the queue, leaving pending work untouched. */
export function withoutResolvedEdits<T extends { status: ReviewEditStatus }>(
  edits: readonly T[],
  { keepUnapplicable = false }: PruneOptions = {},
): T[] {
  return edits.filter(
    (edit) =>
      edit.status === 'pending' ||
      (keepUnapplicable && edit.status === 'unapplicable'),
  );
}

export function hasResolvedEdits(
  edits: readonly { status: ReviewEditStatus }[],
): boolean {
  return edits.some((edit) => isResolved(edit.status));
}

/**
 * The patch that undoes an accepted edit: swap the two sides and let the
 * normal first-occurrence apply put the original text back.
 *
 * Returns null for a pure deletion (`after` is empty) — there is no string
 * to search for, so its position is unrecoverable and the caller must
 * refuse rather than guess where the text belonged.
 */
export function invertPatch(edit: EditPatch): EditPatch | null {
  if (!edit.after) return null;
  return { id: edit.id, before: edit.after, after: edit.before };
}
