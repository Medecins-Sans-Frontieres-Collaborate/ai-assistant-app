import {
  SKILL_LIMITS,
  SkillReferenceIdSchema,
} from '@/lib/services/skills/types';

import type { ConversationEntry } from '@/types/chat';

/** Deduplicates persisted/imported ids and enforces the shared explicit-use cap. */
export function normalizeSkillIds(
  ids: readonly string[] | undefined,
): string[] {
  return [
    ...new Set(
      (ids ?? []).filter((id) => SkillReferenceIdSchema.safeParse(id).success),
    ),
  ].slice(0, SKILL_LIMITS.maxForcedPerTurn);
}

/** Combines standing pins and next-message selections. Pins retain their slots. */
export function skillSelectionForRequest(
  pins: readonly string[] | undefined,
  requested: readonly string[] | undefined,
): {
  forcedSkillIds?: string[];
  pinnedSkillIds?: string[];
} {
  const pinned = normalizeSkillIds(pins);
  const forced = normalizeSkillIds([...pinned, ...(requested ?? [])]);
  return {
    forcedSkillIds: forced.length ? forced : undefined,
    pinnedSkillIds: pinned.length ? pinned : undefined,
  };
}

/** New picker choices replace a message's saved choices; approval resumes leave the picker alone. */
export function requestedSkillsForMessage(
  saved: readonly string[] | undefined,
  picker: readonly string[],
  approvalResume = false,
): string[] {
  return normalizeSkillIds(!approvalResume && picker.length ? picker : saved);
}

/** Preserve choices through snapshot-based retry/finalization without appending future history. */
export function mergeSkillRequestMetadata(
  snapshot: ConversationEntry[],
  live: ConversationEntry[],
): ConversationEntry[] {
  return snapshot.map((entry, index) => {
    if (!('role' in entry) || entry.role !== 'user') return entry;
    const current = entry.id
      ? live.find(
          (candidate) => 'role' in candidate && candidate.id === entry.id,
        )
      : live[index];
    if (
      !current ||
      !('role' in current) ||
      current.role !== 'user' ||
      (!entry.id && current.content !== entry.content) ||
      !current.requestedSkillIds
    )
      return entry;
    return {
      ...entry,
      requestedSkillIds: normalizeSkillIds(current.requestedSkillIds),
    };
  });
}
