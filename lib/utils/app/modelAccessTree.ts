/**
 * The model approval tree the admin edits (docs/LIMITS.md "Model approval"):
 * families → models, each node carrying its stored rule and the EFFECTIVE
 * default for everyone not on a list, resolved with the real resolver over
 * the draft so what the view says a model inherits is what the send does.
 *
 * Pure and dependency-light (lib/, not components/) so it is unit-tested
 * under the node config.
 */
import {
  resolveLimit,
  resolveModelCells,
  resolveModelGate,
} from '@/lib/services/limits/resolver';
import type {
  LimitEntry,
  LimitsPolicy,
  ModelAccessDefault,
  ModelAccessRule,
} from '@/lib/services/limits/types';
import type { Principal } from '@/lib/services/shared/principalMatching';

import { OpenAIModel, OpenAIModels } from '@/types/openai';

import { getLimitDefinition, isExternalByCatalog } from '@/config/limits';

export interface ModelAccessDimension {
  modelId?: string;
  series?: string;
}

export interface ModelAccessModelNode {
  kind: 'model';
  modelId: string;
  label: string;
  series?: string;
  /** False when only a stored rule mentions it — annotated, never pruned. */
  known: boolean;
}

export interface ModelAccessFamilyNode {
  kind: 'family';
  series: string;
  label: string;
  models: ModelAccessModelNode[];
  known: boolean;
}

export interface ModelAccessTree {
  families: ModelAccessFamilyNode[];
  /** Models that declare no series: a model rule is the only rule they can have. */
  orphans: ModelAccessModelNode[];
}

/**
 * The static catalog UNDER the live list: the live list (`/api/models`) is
 * filtered by `model.allowed` in enforce mode, so an admin who is themselves
 * not granted a family would otherwise not see it to grant it. Live entries
 * win on metadata (labels, series) where both have the model.
 */
export function catalogModelsForAdmin(
  liveModels: readonly OpenAIModel[],
): OpenAIModel[] {
  const byId = new Map<string, OpenAIModel>();
  for (const model of Object.values(OpenAIModels)) byId.set(model.id, model);
  for (const model of liveModels) {
    if (!model.id) continue;
    byId.set(model.id, { ...byId.get(model.id), ...model });
  }
  return [...byId.values()];
}

const byRankThenLabel = (
  a: { rank: number; label: string },
  b: { rank: number; label: string },
) => a.rank - b.rank || a.label.localeCompare(b.label);

export function buildModelAccessTree(
  models: readonly OpenAIModel[],
  rules: readonly ModelAccessRule[],
): ModelAccessTree {
  const families = new Map<
    string,
    ModelAccessFamilyNode & {
      members: Array<{
        rank: number;
        label: string;
        node: ModelAccessModelNode;
      }>;
    }
  >();
  const orphans: Array<{
    rank: number;
    label: string;
    node: ModelAccessModelNode;
  }> = [];
  const seen = new Set<string>();

  for (const model of models) {
    if (!model.id || seen.has(model.id.toLowerCase())) continue;
    seen.add(model.id.toLowerCase());
    const node: ModelAccessModelNode = {
      kind: 'model',
      modelId: model.id,
      label: model.name || model.id,
      ...(model.series ? { series: model.series } : {}),
      known: true,
    };
    const ranked = {
      rank: model.variantRank ?? Number.MAX_SAFE_INTEGER,
      label: node.label,
      node,
    };
    if (!model.series) {
      orphans.push(ranked);
      continue;
    }
    const key = model.series.toLowerCase();
    const family = families.get(key) ?? {
      kind: 'family' as const,
      series: model.series,
      label: model.seriesLabel || model.series,
      models: [],
      known: true,
      members: [],
    };
    family.members.push(ranked);
    families.set(key, family);
  }

  // Stored rules for dimensions this ring does not serve: show them so they
  // can be seen and removed, flagged as unknown.
  for (const rule of rules) {
    if (rule.series && !families.has(rule.series.toLowerCase())) {
      families.set(rule.series.toLowerCase(), {
        kind: 'family',
        series: rule.series,
        label: rule.series,
        models: [],
        known: false,
        members: [],
      });
    }
    if (rule.modelId && !seen.has(rule.modelId.toLowerCase())) {
      seen.add(rule.modelId.toLowerCase());
      orphans.push({
        rank: Number.MAX_SAFE_INTEGER,
        label: rule.modelId,
        node: {
          kind: 'model',
          modelId: rule.modelId,
          label: rule.modelId,
          known: false,
        },
      });
    }
  }

  const familyNodes = [...families.values()]
    .map(({ members, ...family }) => ({
      ...family,
      models: [...members].sort(byRankThenLabel).map((m) => m.node),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    families: familyNodes,
    orphans: [...orphans].sort(byRankThenLabel).map((m) => m.node),
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function sameDimension(
  rule: ModelAccessDimension,
  dim: ModelAccessDimension,
): boolean {
  if (dim.modelId)
    return rule.modelId?.toLowerCase() === dim.modelId.toLowerCase();
  if (dim.series)
    return (
      !rule.modelId && rule.series?.toLowerCase() === dim.series.toLowerCase()
    );
  return false;
}

export function ruleFor(
  rules: readonly ModelAccessRule[],
  dim: ModelAccessDimension,
): ModelAccessRule | undefined {
  return rules.find((rule) => sameDimension(rule, dim));
}

export function emptyRule(dim: ModelAccessDimension): ModelAccessRule {
  return {
    ...(dim.modelId ? { modelId: dim.modelId } : { series: dim.series }),
    groups: [],
    domains: [],
    allow: [],
    deny: [],
  };
}

/** A rule that says nothing is not stored. */
export function isEmptyRule(rule: ModelAccessRule): boolean {
  return (
    rule.defaultAccess === undefined &&
    rule.groups.length === 0 &&
    rule.domains.length === 0 &&
    rule.allow.length === 0 &&
    rule.deny.length === 0
  );
}

/** Replaces (or inserts) the rule for `dim`; an empty result removes it. Order is kept. */
export function upsertRule(
  rules: readonly ModelAccessRule[],
  dim: ModelAccessDimension,
  next: ModelAccessRule,
): ModelAccessRule[] {
  const without = rules.filter((rule) => !sameDimension(rule, dim));
  if (isEmptyRule(next)) return without;
  const index = rules.findIndex((rule) => sameDimension(rule, dim));
  if (index < 0) return [...without, next];
  return rules.map((rule, i) => (i === index ? next : rule));
}

/**
 * Does the generic defaults editor ALSO set this node's cell? The PUT refuses
 * that (one place or the other), so the view warns before Save.
 */
export function collidesWithDefaults(
  dim: ModelAccessDimension,
  rule: ModelAccessRule | undefined,
  defaults: readonly LimitEntry[],
): boolean {
  if (rule?.defaultAccess === undefined) return false;
  return defaults.some(
    (entry) =>
      (entry.limitKey === 'model.allowed' ||
        entry.limitKey === 'model.requests') &&
      sameDimension(entry, dim),
  );
}

// ---------------------------------------------------------------------------
// Effective default for everyone not on a list
// ---------------------------------------------------------------------------

export type AccessState =
  | { kind: 'unlimited' }
  | { kind: 'limited'; requests: number }
  | { kind: 'unavailable' };

/** Where the effective default comes from, for the "inherits … from …" line. */
export type AccessOrigin =
  | 'model'
  | 'family'
  | 'defaults'
  | 'catalogExternal'
  | 'catalog';

export interface EffectiveAccess {
  state: AccessState;
  origin: AccessOrigin;
}

export function stateOfDefault(value: ModelAccessDefault): AccessState {
  if (value === false) return { kind: 'unavailable' };
  if (value === null) return { kind: 'unlimited' };
  return { kind: 'limited', requests: value };
}

const EVERYONE_ELSE: Principal = {
  userId: 'model-access-preview',
  attributes: [],
  groupIds: [],
};

/** A draft as a policy the resolver can read; overrides are irrelevant to the default. */
function draftPolicy(
  defaults: readonly LimitEntry[],
  modelAccess: readonly ModelAccessRule[],
): LimitsPolicy {
  return {
    version: 1,
    defaults: [...defaults],
    overrides: [],
    modelAccess: [...modelAccess],
    delegations: [],
    mode: 'enforce',
    failMode: 'open',
    timezone: 'UTC',
    countByomUsage: false,
    countAuxiliaryUsage: false,
    updatedBy: '',
    updatedAt: '',
  };
}

/**
 * What a person on no list gets for this node, resolved exactly as the send
 * resolves it (merged gate; request cells conjunctive, the tightest shown).
 * `series` is the model's family, for a model node.
 */
export function effectiveAccessFor(
  dim: ModelAccessDimension,
  series: string | undefined,
  defaults: readonly LimitEntry[],
  rules: readonly ModelAccessRule[],
): EffectiveAccess {
  const allowedDef = getLimitDefinition('model.allowed');
  const requestsDef = getLimitDefinition('model.requests');
  if (!allowedDef || !requestsDef)
    return { state: { kind: 'unlimited' }, origin: 'catalog' };
  const policy = draftPolicy(defaults, rules);
  const family = dim.modelId ? series : dim.series;

  const gate = resolveModelGate(
    allowedDef,
    policy,
    EVERYONE_ELSE,
    dim.modelId,
    family,
  );

  const own = ruleFor(rules, dim);
  const familyRule =
    dim.modelId && family ? ruleFor(rules, { series: family }) : undefined;
  const origin: AccessOrigin =
    own?.defaultAccess !== undefined
      ? 'model'
      : familyRule?.defaultAccess !== undefined
        ? 'family'
        : gate.source !== 'catalog'
          ? 'defaults'
          : isExternalByCatalog(
                dim.modelId ? { modelId: dim.modelId } : { series: family },
              )
            ? 'catalogExternal'
            : 'catalog';
  // A family node's own rule is "this node", not "its family".
  const nodeOrigin: AccessOrigin =
    !dim.modelId && origin === 'family' ? 'model' : origin;

  if (gate.value === false)
    return { state: { kind: 'unavailable' }, origin: nodeOrigin };

  const cells = dim.modelId
    ? resolveModelCells(requestsDef, policy, EVERYONE_ELSE, dim.modelId, family)
    : [resolveLimit(requestsDef, policy, EVERYONE_ELSE, undefined, dim.series)];
  const numeric = cells
    .map((cell) => cell.value)
    .filter((value): value is number => typeof value === 'number');
  if (numeric.length === 0)
    return { state: { kind: 'unlimited' }, origin: nodeOrigin };
  // Requests may come from a different layer than availability; when a cap
  // binds and nothing in the approval rules set it, the global defaults did.
  const requestsOrigin: AccessOrigin =
    own?.defaultAccess !== undefined && own.defaultAccess !== false
      ? 'model'
      : familyRule?.defaultAccess !== undefined &&
          familyRule.defaultAccess !== false
        ? 'family'
        : 'defaults';
  return {
    state: { kind: 'limited', requests: Math.min(...numeric) },
    origin:
      nodeOrigin === 'catalogExternal' || nodeOrigin === 'catalog'
        ? requestsOrigin
        : nodeOrigin,
  };
}

/** The external families, for the tab's note ("Claude"). */
export function externalFamilyLabels(tree: ModelAccessTree): string[] {
  return tree.families
    .filter((family) => isExternalByCatalog({ series: family.series }))
    .map((family) => family.label);
}
