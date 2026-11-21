/**
 * Small builders for limits policies in tests. Values default to the
 * shapes the schemas would fill in, so a test states only what it is about.
 */
import {
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  LimitsPolicy,
  LimitsPolicySchema,
  OverrideScope,
} from '@/lib/services/limits/types';

const STAMP = '2026-01-01T00:00:00.000Z';

let overrideCounter = 0;

/** One entry; the key defaults to messages per day. */
export function entry(partial: Partial<LimitEntry> = {}): LimitEntry {
  return {
    limitKey: 'chat.messagesPerDay',
    value: null,
    ceiling: false,
    ...partial,
  };
}

/** An enabled override with a fresh `lim-` id. */
export function override(
  scope: OverrideScope,
  targets: string[],
  entries: Partial<LimitEntry>[],
  extra: Partial<LimitOverride> = {},
): LimitOverride {
  overrideCounter += 1;
  return {
    id: `lim-${overrideCounter.toString(16).padStart(12, '0')}`,
    label: '',
    enabled: true,
    scope,
    targets,
    priority: 0,
    entries: entries.map(entry),
    createdBy: 'admin',
    createdAt: STAMP,
    updatedBy: 'admin',
    updatedAt: STAMP,
    ...extra,
  };
}

/** An enabled delegation over the given jurisdiction. */
export function delegation(
  id: string,
  jurisdiction: LimitDelegation['jurisdiction'],
  extra: Partial<LimitDelegation> = {},
): LimitDelegation {
  return {
    id,
    label: id,
    enabled: true,
    admins: ['scoped@example.org'],
    jurisdiction,
    maxOverrides: 25,
    createdBy: 'admin',
    createdAt: STAMP,
    updatedBy: 'admin',
    updatedAt: STAMP,
    ...extra,
  };
}

/** A parsed policy, so every default the schema adds is present. */
export function policy(
  defaults: Partial<LimitEntry>[],
  overrides: LimitOverride[] = [],
  extra: Partial<LimitsPolicy> = {},
): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults: defaults.map(entry),
    overrides,
    updatedBy: 'admin',
    updatedAt: STAMP,
    ...extra,
  });
}
