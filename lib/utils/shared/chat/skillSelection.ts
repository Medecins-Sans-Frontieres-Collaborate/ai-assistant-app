import {
  SKILL_LIMITS,
  SkillReferenceIdSchema,
} from '@/lib/services/skills/types';

import type { ConversationEntry, ToolCallRecord } from '@/types/chat';

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

/**
 * The organization skill versions a finished turn applied, read from its
 * `use_skills` record (SkillEnricher puts `{applied:[{id,updatedAt}]}` in
 * the record's arguments) — docs/SKILLS_DESIGN.md §5.7.
 */
export function appliedSkillVersionsFromToolCalls(
  toolCalls: readonly ToolCallRecord[] | undefined,
): Record<string, string> | undefined {
  const versions: Record<string, string> = {};
  for (const call of toolCalls ?? []) {
    if (call.name !== 'use_skills' || !call.arguments) continue;
    try {
      const parsed = JSON.parse(call.arguments) as {
        applied?: { id?: unknown; updatedAt?: unknown }[];
      };
      for (const entry of parsed.applied ?? []) {
        if (
          typeof entry.id === 'string' &&
          typeof entry.updatedAt === 'string' &&
          SkillReferenceIdSchema.safeParse(entry.id).success
        )
          versions[entry.id] = entry.updatedAt;
      }
    } catch {
      // A hand-edited or foreign record: no pins, current versions apply.
    }
  }
  return Object.keys(versions).length ? versions : undefined;
}

/** Records the applied versions on the last user message before `before` (or the last one). */
export function attachAppliedSkillVersions(
  messages: ConversationEntry[],
  versions: Record<string, string> | undefined,
  before = messages.length,
): ConversationEntry[] {
  if (!versions) return messages;
  const index = messages
    .slice(0, before)
    .findLastIndex((entry) => 'role' in entry && entry.role === 'user');
  if (index < 0) return messages;
  return messages.map((entry, position) =>
    position === index ? { ...entry, appliedSkillVersions: versions } : entry,
  );
}

/**
 * Version pins for a request: only when the message's SAVED requests are
 * being replayed (regeneration/retry), and only for ids still requested.
 * Fresh picker choices run the current version.
 */
export function skillVersionsForRequest(
  saved: Record<string, string> | undefined,
  requested: readonly string[] | undefined,
  replaying: boolean,
): Record<string, string> | undefined {
  if (!replaying || !saved || !requested?.length) return undefined;
  const pins = Object.fromEntries(
    requested
      .filter((id) => typeof saved[id] === 'string' && !id.startsWith('user:'))
      .map((id) => [id, saved[id]]),
  );
  return Object.keys(pins).length ? pins : undefined;
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
