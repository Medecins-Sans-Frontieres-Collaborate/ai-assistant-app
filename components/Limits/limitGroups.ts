/**
 * Feature-first grouping of the limits catalog for the admin UI.
 *
 * PURELY PRESENTATIONAL: catalog keys, wire schemas and the resolver know
 * nothing about groups. The catalog's `category` field orders keys by
 * mechanical kind (gates, ceilings, counters), which put "Code interpreter"
 * and "Code interpreter runs per day" four rows apart; this map re-groups
 * the same 17 keys by the feature an admin is actually reasoning about, so
 * a feature's on/off gate and its caps render together.
 *
 * A drift guard (__tests__/components/limits/limitGroups.test.ts) asserts
 * every catalog key appears in exactly one group, so a future catalog key
 * cannot silently fall out of the admin UI.
 */
import { LimitValueState } from '@/components/Limits/LimitValueInput';

import { LimitDefinition, getLimitDefinition } from '@/config/limits';

export type LimitGroupId =
  | 'chat'
  | 'models'
  | 'webSearch'
  | 'codeInterpreter'
  | 'mcp'
  | 'readAloud'
  | 'transcription'
  | 'uploads'
  | 'translation';

export interface LimitGroup {
  id: LimitGroupId;
  /**
   * Boolean on/off key rendered inline in the group header. When it is
   * explicitly `false` in a draft, the group's member caps are dead
   * configuration (the gate refuses the request before any counter is
   * consumed) — the UI dims them. Only webSearch/codeInterpreter/mcp have
   * one; `model.allowed` is a perModel boolean, not a group gate.
   */
  gateKey?: string;
  /** Cap keys rendered as rows under the header, in display order. */
  memberKeys: readonly string[];
  /**
   * Set when gate-off and cap-blocked produce DIFFERENT user-facing
   * behavior worth explaining: the gate refuses the whole request with an
   * admin message, while an exhausted/blocked counter silently skips the
   * tool and the chat continues without it.
   */
  consequenceKey?: 'webSearch' | 'codeInterpreter' | 'mcp';
}

export const LIMIT_GROUPS: readonly LimitGroup[] = [
  {
    id: 'chat',
    memberKeys: [
      'chat.messagesPerDay',
      'chat.tokensPerDay',
      'chat.tokensPerMonth',
    ],
  },
  {
    id: 'models',
    memberKeys: ['model.allowed', 'model.requests'],
  },
  {
    id: 'webSearch',
    gateKey: 'feature.webSearch.enabled',
    memberKeys: ['feature.webSearch.callsPerDay'],
    consequenceKey: 'webSearch',
  },
  {
    id: 'codeInterpreter',
    gateKey: 'feature.codeInterpreter.enabled',
    memberKeys: ['feature.codeInterpreter.runsPerDay'],
    consequenceKey: 'codeInterpreter',
  },
  {
    id: 'mcp',
    gateKey: 'feature.mcp.enabled',
    memberKeys: [
      'feature.mcp.roundsPerRequest',
      'feature.m365.toolCallsPerDay',
      'feature.m365.mail.readsPerDay',
      'feature.m365.mail.draftsPerDay',
      'feature.m365.mail.deepScansPerDay',
    ],
    consequenceKey: 'mcp',
  },
  {
    id: 'readAloud',
    memberKeys: [
      'feature.tts.charactersPerRequest',
      'feature.tts.charactersPerDay',
    ],
  },
  {
    id: 'transcription',
    memberKeys: ['feature.transcription.minutesPerDay'],
  },
  {
    id: 'uploads',
    memberKeys: [
      'feature.upload.megabytesPerFile',
      'feature.upload.filesPerDay',
    ],
  },
  {
    id: 'translation',
    memberKeys: ['feature.translation.jobsPerDay'],
  },
];

const GROUP_BY_KEY = new Map<string, LimitGroup>(
  LIMIT_GROUPS.flatMap((group) =>
    [...(group.gateKey ? [group.gateKey] : []), ...group.memberKeys].map(
      (key) => [key, group] as const,
    ),
  ),
);

export function groupOfKey(key: string): LimitGroup | undefined {
  return GROUP_BY_KEY.get(key);
}

/** Definitions for a group's members, in the group's display order. */
export function memberDefinitions(group: LimitGroup): LimitDefinition[] {
  return group.memberKeys
    .map((key) => getLimitDefinition(key))
    .filter((def): def is LimitDefinition => def !== undefined);
}

/**
 * Seed value for a newly added entry (override row or scoped cell).
 *
 * ⚠ NEVER `null`: in an override, `null` is explicit-unlimited and would
 * grant unlimited access to the targeted users the moment the admin saves;
 * in a scoped cell, qualifier specificity beats restrictiveness in the
 * resolver, so a `null` family entry would defeat a stricter unqualified
 * default. Booleans seed blocked, counters seed a concrete number clamped
 * to any compiled hard ceiling (e.g. mcp.roundsPerRequest's 25).
 */
export function seedValueFor(def: LimitDefinition): LimitValueState {
  if (def.unit === 'boolean') return false;
  return Math.min(100, def.hardCeiling ?? Number.POSITIVE_INFINITY);
}
