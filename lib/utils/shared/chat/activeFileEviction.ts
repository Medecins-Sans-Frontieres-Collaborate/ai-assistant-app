import { ActiveFile } from '@/types/chat';

/**
 * Eviction order for the per-conversation active-file cap. Stated once
 * here; `evictActiveFilesOverCap` is the only reader.
 *
 *  0. Unpinned files — the user never asked to keep them.
 *  1. Auto-pinned files (`pinned` set by the "auto-pin uploads" setting,
 *     marked `autoPinned`) — pinned by default, not by choice.
 *  Never: files the user pinned themselves.
 *
 * Auto-pinned files used to be as protected as user pins. With auto-pin on
 * by default that made the cap unreachable: a conversation collected 22
 * "active" files of which a turn could carry two.
 */
const EVICTION_TIERS: ReadonlyArray<(file: ActiveFile) => boolean> = [
  (file) => !file.pinned,
  (file) => !!file.pinned && !!file.autoPinned,
];

/**
 * Trims an active-file list to the conversation's cap, oldest first within
 * each eviction tier (see EVICTION_TIERS).
 *
 * @param files - The list after adding `incoming`.
 * @param maxFiles - The conversation's active-file cap (>= 0).
 * @param incoming - The file just activated; never evicted itself.
 * @returns A list of at most `maxFiles` entries where eviction allows; it
 *          stays longer only when everything else is user-pinned.
 *
 * @example
 * // cap 2: the oldest auto-pinned file makes room for the new upload
 * evictActiveFilesOverCap([oldAutoPinned, userPinned, incoming], 2, incoming);
 * // => [userPinned, incoming]
 */
export function evictActiveFilesOverCap(
  files: readonly ActiveFile[],
  maxFiles: number,
  incoming: ActiveFile,
): ActiveFile[] {
  const next = files.slice();
  for (const inTier of EVICTION_TIERS) {
    while (next.length > maxFiles) {
      const candidates = next.filter(
        (file) => inTier(file) && file.id !== incoming.id,
      );
      if (candidates.length === 0) break;
      const oldest = candidates.reduce((a, b) =>
        a.addedAt.localeCompare(b.addedAt) <= 0 ? a : b,
      );
      next.splice(next.indexOf(oldest), 1);
    }
  }
  return next;
}
