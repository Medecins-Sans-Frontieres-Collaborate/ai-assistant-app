/**
 * What a limits edit DOES, for the admin views. Pure and client-importable.
 *
 * Two questions, both answered with the real resolver so the admin views can
 * never describe a rule differently from how it is enforced:
 *
 *  - {@link ruleEffect}: for one entry of one override, what would a member
 *    of its audience get with it, and without it? When those are the same
 *    the rule has no effect as set, and the reason says why (a hard ceiling
 *    holds it, a higher-ranked rule outranks it, or its delegation does not
 *    reach the audience).
 *  - {@link diffPolicies}: every difference between the saved policy and a
 *    draft, each classified by direction (looser, stricter, removes a cap,
 *    adds a cap) with risk flags for the review screen.
 *
 * Direction convention, stated once: a change is LOOSER when people get
 * more (a higher cap, unlimited, access turned on) and STRICTER when they
 * get less, judged by the resolver's own `restrictiveness` ordering
 * (false < 0 < 1 < ... < unlimited < true). Every caller cites this.
 */
import {
  LimitExplanation,
  explainLimit,
  restrictiveness,
} from '@/lib/services/limits/resolver';
import type {
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  LimitValue,
  LimitsPolicy,
  ModelAccessRule,
  OverrideScope,
} from '@/lib/services/limits/types';
import type { Principal } from '@/lib/services/shared/principalMatching';

import { LimitDefinition, getLimitDefinition } from '@/config/limits';

/** A cell: one limit key, optionally qualified by one model or family. */
export interface LimitCell {
  limitKey: string;
  modelId?: string;
  series?: string;
}

/** Stable identity of a cell, for maps and React keys. */
export function cellId(cell: LimitCell): string {
  if (cell.modelId)
    return `${cell.limitKey}|model:${cell.modelId.toLowerCase()}`;
  if (cell.series)
    return `${cell.limitKey}|family:${cell.series.toLowerCase()}`;
  return cell.limitKey;
}

/** Matches no override: what someone with no domain, groups or attributes gets. */
export const ANONYMOUS_PRINCIPAL: Principal = {
  userId: '',
  attributes: [],
  groupIds: [],
};

/**
 * A principal that matches exactly one target, plus (for a delegated rule)
 * the first predicate of its delegation's jurisdiction so the rule is not
 * inert for it. Stands in for "a member of this audience with no other
 * memberships".
 */
export function memberPrincipal(
  scope: OverrideScope,
  target: string,
  delegation?: LimitDelegation,
): Principal {
  const principal: Principal = {
    userId: 'audience-member',
    attributes: [],
    groupIds: [],
  };
  addFacet(principal, scope, target);
  const predicate = delegation?.jurisdiction[0];
  if (predicate?.targets[0]) {
    addFacet(principal, predicate.scope, predicate.targets[0]);
  }
  return principal;
}

function addFacet(
  principal: Principal,
  scope: OverrideScope,
  target: string,
): void {
  const value = target.trim().toLowerCase();
  if (!value) return;
  if (scope === 'user') {
    principal.mail = value;
    principal.domain ??= value.split('@').pop();
  } else if (scope === 'domain') {
    principal.domain ??= value;
  } else if (scope === 'attribute') {
    principal.attributes.push(value);
  } else {
    principal.groupIds.push(value);
  }
}

/**
 * What everyone without an exception gets for a cell under `policy`: the
 * global defaults over the compiled catalog.
 */
export function everyoneValue(
  policy: LimitsPolicy | null,
  cell: LimitCell,
): LimitExplanation | null {
  const def = getLimitDefinition(cell.limitKey);
  if (!def) return null;
  return explainLimit(
    def,
    policy,
    ANONYMOUS_PRINCIPAL,
    cell.modelId,
    cell.series,
  );
}

/** Why a rule entry's value is not what its audience ends up with. */
export type RuleEffectStatus =
  /** The audience gets this rule's value. */
  | 'applies'
  /** A hard ceiling holds the audience below this rule's value. */
  | 'held-by-ceiling'
  /** A more specific or higher-ranked rule decides instead. */
  | 'outranked'
  /** The rule is off, or its delegation is off or does not reach them. */
  | 'inert';

export interface RuleEffect {
  status: RuleEffectStatus;
  /** What a member gets without this rule. */
  otherwise: LimitExplanation;
  /** What a member gets with it. */
  withRule: LimitExplanation;
}

/**
 * The effect of one entry of one override on a member of its audience.
 *
 * @param policy - The policy the override lives in (usually the draft).
 * @param override - The rule; must be in `policy.overrides`.
 * @param entry - One of `override.entries`.
 * @returns Null when the rule has no targets or the key is unknown.
 */
export function ruleEffect(
  policy: LimitsPolicy,
  override: LimitOverride,
  entry: LimitEntry,
): RuleEffect | null {
  const def = getLimitDefinition(entry.limitKey);
  const target = override.targets.find((value) => value.trim());
  if (!def || !target) return null;
  const delegation = override.delegationId
    ? policy.delegations.find((d) => d.id === override.delegationId)
    : undefined;
  const principal = memberPrincipal(override.scope, target, delegation);
  const without: LimitsPolicy = {
    ...policy,
    overrides: policy.overrides.filter((o) => o.id !== override.id),
  };
  const withRule = explainLimit(
    def,
    policy,
    principal,
    entry.modelId,
    entry.series,
  );
  const otherwise = explainLimit(
    def,
    without,
    principal,
    entry.modelId,
    entry.series,
  );
  return {
    status: effectStatus(override, withRule),
    otherwise,
    withRule,
  };
}

function effectStatus(
  override: LimitOverride,
  withRule: LimitExplanation,
): RuleEffectStatus {
  const own = withRule.considered.find(
    (candidate) => candidate.overrideId === override.id,
  );
  if (!own) return 'inert';
  if (withRule.resolved.overrideId !== override.id) return 'outranked';
  if (
    withRule.resolved.ceilingApplied ||
    withRule.resolved.hardCeilingApplied
  ) {
    return 'held-by-ceiling';
  }
  return 'applies';
}

/** Direction of a change; see the module header for the convention. */
export type ChangeDirection = 'looser' | 'stricter' | 'same';

/** Compares two resolved values by the resolver's ordering. */
export function directionOf(
  before: LimitValue,
  after: LimitValue,
): ChangeDirection {
  const from = restrictiveness(before);
  const to = restrictiveness(after);
  if (to > from) return 'looser';
  if (to < from) return 'stricter';
  return 'same';
}

/** The audience a change speaks to. */
export type ChangeAudience =
  | { kind: 'everyone' }
  | {
      kind: 'rule';
      overrideId: string;
      label: string;
      scope: OverrideScope;
      targets: string[];
      delegationId?: string;
    };

/** One set value: absent `value` means the rule does not set the cell. */
export interface SetValue {
  value?: LimitValue;
  ceiling: boolean;
}

export type RiskFlag =
  /** A cap became unlimited. */
  | 'removes-cap'
  /** A hard ceiling was turned off or its rule removed. */
  | 'removes-ceiling'
  /** A delegated admin's rule now grants more. */
  | 'delegated-loosening'
  /** The rule is set but changes nothing for its audience. */
  | 'no-effect';

/** One cell of one audience that differs between saved and draft. */
export interface ValueChange {
  type: 'value';
  audience: ChangeAudience;
  cell: LimitCell;
  before: SetValue;
  after: SetValue;
  /**
   * What a member of the audience ends up with, saved vs draft, through the
   * resolver: the direction is judged on THESE, not on the set values, so a
   * rule pinned by a ceiling reads as no change.
   */
  resolvedBefore: LimitValue;
  resolvedAfter: LimitValue;
  direction: ChangeDirection;
  flags: RiskFlag[];
}

/** An audience change, or a rule switched on or off, or added or removed. */
export interface RuleChange {
  type: 'rule';
  audience: Extract<ChangeAudience, { kind: 'rule' }>;
  change:
    | 'added'
    | 'removed'
    | 'enabled'
    | 'disabled'
    | 'audience'
    | 'priority';
}

/** Anything else that is part of the policy document. */
export interface OtherChange {
  type: 'setting' | 'delegation' | 'model-access';
  /** Setting name, delegation id or model access dimension. */
  subject: string;
  before?: string;
  after?: string;
}

export type PolicyChange = ValueChange | RuleChange | OtherChange;

const SETTINGS = [
  'mode',
  'failMode',
  'timezone',
  'countByomUsage',
  'countAuxiliaryUsage',
] as const;

/**
 * Every difference between the saved policy and a draft, most consequential
 * first: value changes (with direction and risk flags), then rule changes,
 * then settings, delegations and model access.
 *
 * @param saved - The stored policy, or null when none has been saved yet.
 * @param draft - The edited policy.
 */
export function diffPolicies(
  saved: LimitsPolicy | null,
  draft: LimitsPolicy,
): PolicyChange[] {
  const values: ValueChange[] = [
    ...defaultChanges(saved, draft),
    ...overrideValueChanges(saved, draft),
  ];
  return [
    ...values,
    ...ruleChanges(saved, draft),
    ...settingChanges(saved, draft),
    ...delegationChanges(saved, draft),
    ...modelAccessChanges(saved, draft),
  ];
}

function setValueMap(entries: readonly LimitEntry[]): Map<string, LimitEntry> {
  return new Map(entries.map((entry) => [cellId(entry), entry]));
}

function toSetValue(entry: LimitEntry | undefined): SetValue {
  return entry
    ? { value: entry.value, ceiling: entry.ceiling }
    : { ceiling: false };
}

function sameSetValue(a: SetValue, b: SetValue): boolean {
  return a.value === b.value && a.ceiling === b.ceiling;
}

function cellOf(entry: LimitEntry): LimitCell {
  return {
    limitKey: entry.limitKey,
    ...(entry.modelId ? { modelId: entry.modelId } : {}),
    ...(entry.series ? { series: entry.series } : {}),
  };
}

function resolveFor(
  def: LimitDefinition,
  policy: LimitsPolicy | null,
  principal: Principal,
  cell: LimitCell,
): LimitValue {
  return explainLimit(def, policy, principal, cell.modelId, cell.series)
    .resolved.value;
}

function defaultChanges(
  saved: LimitsPolicy | null,
  draft: LimitsPolicy,
): ValueChange[] {
  const before = setValueMap(saved?.defaults ?? []);
  const after = setValueMap(draft.defaults);
  const changes: ValueChange[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const was = toSetValue(before.get(id));
    const now = toSetValue(after.get(id));
    if (sameSetValue(was, now)) continue;
    const entry = (after.get(id) ?? before.get(id)) as LimitEntry;
    const def = getLimitDefinition(entry.limitKey);
    if (!def) continue;
    const cell = cellOf(entry);
    const resolvedBefore = resolveFor(def, saved, ANONYMOUS_PRINCIPAL, cell);
    const resolvedAfter = resolveFor(def, draft, ANONYMOUS_PRINCIPAL, cell);
    changes.push(
      valueChange(
        { kind: 'everyone' },
        cell,
        was,
        now,
        resolvedBefore,
        resolvedAfter,
      ),
    );
  }
  return changes;
}

function overrideValueChanges(
  saved: LimitsPolicy | null,
  draft: LimitsPolicy,
): ValueChange[] {
  const savedById = new Map((saved?.overrides ?? []).map((o) => [o.id, o]));
  const draftById = new Map(draft.overrides.map((o) => [o.id, o]));
  const changes: ValueChange[] = [];
  for (const id of new Set([...savedById.keys(), ...draftById.keys()])) {
    const was = savedById.get(id);
    const now = draftById.get(id);
    const rule = (now ?? was) as LimitOverride;
    const before = setValueMap(
      was?.enabled === false ? [] : (was?.entries ?? []),
    );
    const after = setValueMap(
      now?.enabled === false ? [] : (now?.entries ?? []),
    );
    const target = rule.targets.find((value) => value.trim());
    for (const cellKey of new Set([...before.keys(), ...after.keys()])) {
      const wasValue = toSetValue(before.get(cellKey));
      const nowValue = toSetValue(after.get(cellKey));
      if (sameSetValue(wasValue, nowValue)) continue;
      const entry = (after.get(cellKey) ?? before.get(cellKey)) as LimitEntry;
      const def = getLimitDefinition(entry.limitKey);
      if (!def) continue;
      const cell = cellOf(entry);
      const principal = target
        ? memberPrincipal(
            rule.scope,
            target,
            rule.delegationId
              ? (draft.delegations.find((d) => d.id === rule.delegationId) ??
                  saved?.delegations.find((d) => d.id === rule.delegationId))
              : undefined,
          )
        : ANONYMOUS_PRINCIPAL;
      changes.push(
        valueChange(
          ruleAudience(rule),
          cell,
          wasValue,
          nowValue,
          resolveFor(def, saved, principal, cell),
          resolveFor(def, draft, principal, cell),
        ),
      );
    }
  }
  return changes;
}

function ruleAudience(
  rule: LimitOverride,
): Extract<ChangeAudience, { kind: 'rule' }> {
  return {
    kind: 'rule',
    overrideId: rule.id,
    label: rule.label,
    scope: rule.scope,
    targets: rule.targets,
    ...(rule.delegationId ? { delegationId: rule.delegationId } : {}),
  };
}

function valueChange(
  audience: ChangeAudience,
  cell: LimitCell,
  before: SetValue,
  after: SetValue,
  resolvedBefore: LimitValue,
  resolvedAfter: LimitValue,
): ValueChange {
  const direction = directionOf(resolvedBefore, resolvedAfter);
  const flags: RiskFlag[] = [];
  if (resolvedAfter === null && resolvedBefore !== null) {
    flags.push('removes-cap');
  }
  if (before.ceiling && !after.ceiling) flags.push('removes-ceiling');
  if (
    audience.kind === 'rule' &&
    audience.delegationId &&
    direction === 'looser'
  ) {
    flags.push('delegated-loosening');
  }
  if (
    after.value !== undefined &&
    direction === 'same' &&
    !sameSetValue(before, after)
  ) {
    flags.push('no-effect');
  }
  return {
    type: 'value',
    audience,
    cell,
    before,
    after,
    resolvedBefore,
    resolvedAfter,
    direction,
    flags,
  };
}

function ruleChanges(
  saved: LimitsPolicy | null,
  draft: LimitsPolicy,
): RuleChange[] {
  const savedById = new Map((saved?.overrides ?? []).map((o) => [o.id, o]));
  const draftById = new Map(draft.overrides.map((o) => [o.id, o]));
  const changes: RuleChange[] = [];
  for (const [id, now] of draftById) {
    const was = savedById.get(id);
    if (!was) {
      changes.push({
        type: 'rule',
        audience: ruleAudience(now),
        change: 'added',
      });
      continue;
    }
    if (was.enabled !== now.enabled) {
      changes.push({
        type: 'rule',
        audience: ruleAudience(now),
        change: now.enabled ? 'enabled' : 'disabled',
      });
    }
    if (
      was.scope !== now.scope ||
      was.delegationId !== now.delegationId ||
      !sameList(was.targets, now.targets)
    ) {
      changes.push({
        type: 'rule',
        audience: ruleAudience(now),
        change: 'audience',
      });
    }
    if (was.priority !== now.priority) {
      changes.push({
        type: 'rule',
        audience: ruleAudience(now),
        change: 'priority',
      });
    }
  }
  for (const [id, was] of savedById) {
    if (!draftById.has(id)) {
      changes.push({
        type: 'rule',
        audience: ruleAudience(was),
        change: 'removed',
      });
    }
  }
  return changes;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const norm = (list: readonly string[]) =>
    [...list]
      .map((v) => v.trim().toLowerCase())
      .sort()
      .join('\n');
  return norm(a) === norm(b);
}

function settingChanges(
  saved: LimitsPolicy | null,
  draft: LimitsPolicy,
): OtherChange[] {
  if (!saved) return [];
  return SETTINGS.filter((name) => saved[name] !== draft[name]).map((name) => ({
    type: 'setting',
    subject: name,
    before: String(saved[name]),
    after: String(draft[name]),
  }));
}

function delegationChanges(
  saved: LimitsPolicy | null,
  draft: LimitsPolicy,
): OtherChange[] {
  const before = new Map((saved?.delegations ?? []).map((d) => [d.id, d]));
  const after = new Map(draft.delegations.map((d) => [d.id, d]));
  const changes: OtherChange[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(id);
    const now = after.get(id);
    if (was && now && delegationSignature(was) === delegationSignature(now)) {
      continue;
    }
    changes.push({
      type: 'delegation',
      subject: (now ?? was)?.label || id,
      ...(was ? { before: was.enabled ? 'on' : 'off' } : {}),
      ...(now ? { after: now.enabled ? 'on' : 'off' } : {}),
    });
  }
  return changes;
}

function delegationSignature(delegation: LimitDelegation): string {
  return JSON.stringify([
    delegation.label,
    delegation.enabled,
    [...delegation.admins].sort(),
    delegation.jurisdiction,
    delegation.maxOverrides,
  ]);
}

function modelAccessChanges(
  saved: LimitsPolicy | null,
  draft: LimitsPolicy,
): OtherChange[] {
  const key = (rule: ModelAccessRule) =>
    rule.modelId ? `model:${rule.modelId}` : `family:${rule.series ?? ''}`;
  const before = new Map((saved?.modelAccess ?? []).map((r) => [key(r), r]));
  const after = new Map(draft.modelAccess.map((r) => [key(r), r]));
  const changes: OtherChange[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(id);
    const now = after.get(id);
    if (JSON.stringify(was ?? null) === JSON.stringify(now ?? null)) continue;
    changes.push({ type: 'model-access', subject: id });
  }
  return changes;
}

/** Counts for the unsaved-changes bar and the review header. */
export interface ChangeSummary {
  total: number;
  looser: number;
  stricter: number;
  removesCap: number;
}

/** Summarises {@link diffPolicies} output for the review bar. */
export function summarizeChanges(
  changes: readonly PolicyChange[],
): ChangeSummary {
  const summary: ChangeSummary = {
    total: changes.length,
    looser: 0,
    stricter: 0,
    removesCap: 0,
  };
  for (const change of changes) {
    if (change.type !== 'value') continue;
    if (change.flags.includes('removes-cap')) summary.removesCap += 1;
    else if (change.direction === 'looser') summary.looser += 1;
    else if (change.direction === 'stricter') summary.stricter += 1;
  }
  return summary;
}
