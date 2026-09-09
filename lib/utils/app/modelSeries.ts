import {
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
  getModelTier,
} from '@/types/openai';

/**
 * Version recency from the numeric versionLabel ("5.4" → 5.4, "4o" → 4,
 * "3.2" → 3.2). DEFAULT_MODEL_ORDER can't be used for this: it is display
 * PRIORITY, which ranks e.g. gpt-4.1 above gpt-5.4. The rolling "latest"
 * alias always outranks numbered versions. Ties keep list order (sort is
 * stable and inputs arrive in display order).
 */
export function versionRank(model: Pick<OpenAIModel, 'versionLabel'>): number {
  if (model.versionLabel === 'latest') return Number.POSITIVE_INFINITY;
  const parsed = parseFloat(model.versionLabel ?? '');
  return Number.isNaN(parsed) ? -1 : parsed;
}

/** All versions of `model`'s series within `models`, newest first. */
export function getSeriesVersions(
  models: OpenAIModel[],
  model: Pick<OpenAIModel, 'series'>,
): OpenAIModel[] {
  if (!model.series) return [];
  return models
    .filter((m) => m.series === model.series)
    .sort((a, b) => versionRank(b) - versionRank(a));
}

/**
 * Predicate narrowing which family members a row or switcher may front and
 * select. The picker passes "not exhausted by a usage limit": a family whose
 * default has hit its daily cap should front a sibling that still works
 * rather than a grayed row the user cannot open. Absent = every member
 * qualifies.
 */
export type SelectablePredicate = (model: OpenAIModel) => boolean;

/**
 * The model that fronts a family row: the current selection when it's in
 * this family, else the best-ranked `defaultRank` member (ties go to the
 * newest, since `versions` arrives newest-first — so "rank 1 on every
 * Sonnet" means "latest available Sonnet"), else the FEATURED version, else
 * the newest non-legacy, else the newest. This is also what clicking the
 * row selects, i.e. the family's default.
 *
 * With `isSelectable`, the preference walk runs over the selectable members
 * first and only falls back to the whole list when none qualifies — so the
 * row stays clickable while any sibling is usable, and grays out (with the
 * default's reason) only when the entire family is spent. The current
 * selection still wins outright: the user is already on that model and the
 * header carries its badge.
 */
export function seriesRepresentative(
  versions: OpenAIModel[],
  selectedModelId?: string,
  isSelectable?: SelectablePredicate,
): OpenAIModel | undefined {
  const selected = versions.find((v) => v.id === selectedModelId);
  if (selected) return selected;

  if (isSelectable) {
    const usable = versions.filter(isSelectable);
    if (usable.length > 0 && usable.length < versions.length) {
      return seriesRepresentative(usable, undefined);
    }
  }

  let preferred: OpenAIModel | undefined;
  for (const v of versions) {
    if (v.defaultRank === undefined) continue;
    if (preferred === undefined || v.defaultRank < preferred.defaultRank!) {
      preferred = v;
    }
  }
  return (
    preferred ??
    versions.find((v) => getModelTier(v) === 'featured') ??
    versions.find((v) => getModelTier(v) !== 'legacy') ??
    versions[0]
  );
}

/** One picker row: a family (several members sharing a series) or a plain model. */
export interface FamilyUnit {
  /** Stable render key: `series-${seriesKey}` for families, the model id for plain rows. */
  key: string;
  /** The shared series; absent on plain single-model rows. */
  seriesKey?: string;
  /** Members in input order (a single model for plain rows). */
  members: OpenAIModel[];
}

/**
 * Buckets a display-ordered model list into picker rows: models sharing a
 * series collapse into ONE family unit anchored at the position of its first
 * member; models without a series stay single-member units in place. The
 * series is read from static catalog metadata when the id is known, else
 * from the model object itself (discovered/byom models carry their own —
 * byom series are namespaced per source, so sources never merge with the
 * catalog tree or each other).
 */
export function groupIntoFamilyUnits(models: OpenAIModel[]): FamilyUnit[] {
  const bySeries = new Map<string, FamilyUnit>();
  const units: FamilyUnit[] = [];
  for (const m of models) {
    const seriesKey = (OpenAIModels[m.id as OpenAIModelID] ?? m).series;
    if (!seriesKey) {
      units.push({ key: m.id, members: [m] });
      continue;
    }
    const existing = bySeries.get(seriesKey);
    if (existing) {
      existing.members.push(m);
    } else {
      const unit: FamilyUnit = {
        key: `series-${seriesKey}`,
        seriesKey,
        members: [m],
      };
      bySeries.set(seriesKey, unit);
      units.push(unit);
    }
  }
  return units;
}

/** One variant segment of a family: its stable key, display label, and members. */
export interface FamilyVariant {
  /** `variant` metadata key; '' groups members with no variant (single-variant families). */
  key: string;
  label: string;
  members: OpenAIModel[];
}

/**
 * Distinct variants among the given family members, ordered by
 * `variantRank` (the family's capability hierarchy, e.g. Opus → Sonnet →
 * Haiku). Variants without a rank sort last, in order of first appearance.
 */
export function getFamilyVariants(members: OpenAIModel[]): FamilyVariant[] {
  const byKey = new Map<string, FamilyVariant & { rank: number }>();
  for (const m of members) {
    const key = m.variant ?? '';
    const existing = byKey.get(key);
    if (existing) {
      existing.members.push(m);
      existing.rank = Math.min(m.variantRank ?? Infinity, existing.rank);
    } else {
      byKey.set(key, {
        key,
        label: m.variantLabel ?? '',
        members: [m],
        rank: m.variantRank ?? Infinity,
      });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(({ key, label, members: variantMembers }) => ({
      key,
      label,
      members: variantMembers,
    }));
}

/**
 * Family members restricted to `model`'s variant, newest first. This is what
 * the Version chip strip shows: versions of the ACTIVE variant only.
 */
export function getVariantVersions(
  models: OpenAIModel[],
  model: Pick<OpenAIModel, 'series' | 'variant'>,
): OpenAIModel[] {
  const variantKey = model.variant ?? '';
  return getSeriesVersions(models, model).filter(
    (m) => (m.variant ?? '') === variantKey,
  );
}

/** One sub-variant chip within a version: its key, label, and the model it selects. */
export interface VersionSubVariant {
  /** `subVariant` metadata key; '' groups members that declare none. */
  key: string;
  label: string;
  model: OpenAIModel;
}

/**
 * Sub-variants present at one version, ordered by `subVariantRank` (the
 * capability hierarchy within the version, e.g. Sol → Terra → Luna).
 * Unranked sub-variants sort last, in order of first appearance.
 *
 * A version normally holds exactly one model, so this usually returns a
 * single entry and the caller renders no control at all.
 */
export function getVersionSubVariants(
  versionMembers: OpenAIModel[],
): VersionSubVariant[] {
  return versionMembers
    .map((model) => ({
      key: model.subVariant ?? '',
      label: model.subVariantLabel ?? '',
      model,
      rank: model.subVariantRank ?? Infinity,
    }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ key, label, model }) => ({ key, label, model }));
}

/** One version chip: the shared label and every sub-variant shipped under it. */
export interface VariantVersion {
  /** `versionLabel`, or the single member's id when the version is unlabelled. */
  key: string;
  label: string;
  /** Sub-variants at this version, in `subVariantRank` order. */
  members: OpenAIModel[];
}

/**
 * Versions of `model`'s variant, newest first, COLLAPSING sub-variants into
 * one entry each. This is what the Version chip strip shows: one chip per
 * version of the active variant, however many models ship under it.
 *
 * Grouping is what makes the sub-variant axis work at all — GPT 5.6 ships
 * Sol/Terra/Luna and o-series 3 ships o3/o3-mini, so without it the strip
 * renders duplicate chips reading the same version number and every
 * "keep the user's version" lookup resolves to an arbitrary one of them.
 */
export function getVariantVersionGroups(
  models: OpenAIModel[],
  model: Pick<OpenAIModel, 'series' | 'variant'>,
): VariantVersion[] {
  const byKey = new Map<string, VariantVersion>();
  for (const m of getVariantVersions(models, model)) {
    const key = m.versionLabel ?? m.id;
    const existing = byKey.get(key);
    if (existing) {
      existing.members.push(m);
    } else {
      byKey.set(key, { key, label: m.versionLabel ?? m.name, members: [m] });
    }
  }
  // getVariantVersions already ordered by versionRank, so insertion order is
  // newest-first; only the members within a group need the sub-variant sort.
  return [...byKey.values()].map((group) => ({
    ...group,
    members: getVersionSubVariants(group.members).map((s) => s.model),
  }));
}

/**
 * Family members restricted to `model`'s variant AND version, in
 * `subVariantRank` order — the models one version chip stands for.
 */
export function getVersionMembers(
  models: OpenAIModel[],
  model: Pick<OpenAIModel, 'series' | 'variant' | 'versionLabel'>,
): OpenAIModel[] {
  return (
    getVariantVersionGroups(models, model).find(
      (group) => group.key === model.versionLabel,
    )?.members ?? []
  );
}

/**
 * Picks within a candidate set, preferring the user's current sub-variant so
 * a variant or version switch keeps the size tier they were on (Terra → a
 * different version stays on Terra where that version has one). Falls back
 * to the set's representative when the sub-variant isn't offered there.
 */
function preferSubVariant(
  candidates: OpenAIModel[],
  currentSubVariant: string | undefined,
  gate?: SelectablePredicate,
): OpenAIModel | undefined {
  if (currentSubVariant !== undefined) {
    const sameSubVariant = candidates.filter(
      (m) => (m.subVariant ?? '') === currentSubVariant,
    );
    if (sameSubVariant.length > 0) {
      const pick = seriesRepresentative(sameSubVariant, undefined, gate);
      if (pick && (!gate || gate(pick))) return pick;
    }
  }
  return seriesRepresentative(candidates, undefined, gate);
}

/**
 * The model to select when the user switches to another variant: the same
 * versionLabel within that variant when it exists (keep the user's version,
 * and within it their sub-variant), else the variant's representative
 * (featured → newest non-legacy → newest).
 *
 * `isSelectable` (see seriesRepresentative) keeps the same-version shortcut
 * only while that version is usable; an exhausted twin falls through to the
 * best selectable sibling, and the whole variant is offered ungated only
 * when nothing in it qualifies (the caller then renders it disabled).
 */
export function pickVariantTarget(
  variantMembers: OpenAIModel[],
  currentVersionLabel: string | undefined,
  isSelectable?: SelectablePredicate,
  currentSubVariant?: string,
): OpenAIModel | undefined {
  // No usable member at all: behave exactly as if ungated, so the caller
  // still gets the natural target to badge and disable.
  const gate =
    isSelectable && variantMembers.some(isSelectable)
      ? isSelectable
      : undefined;
  const sameVersion =
    currentVersionLabel !== undefined
      ? variantMembers.filter((m) => m.versionLabel === currentVersionLabel)
      : [];
  if (sameVersion.length > 0) {
    const pick = preferSubVariant(sameVersion, currentSubVariant, gate);
    if (pick && (!gate || gate(pick))) return pick;
  }
  return preferSubVariant(variantMembers, currentSubVariant, gate);
}

/**
 * The model to select when the user clicks another VERSION chip: their
 * current sub-variant at that version when it ships one, else that version's
 * representative. Versions with a single model always return it.
 */
export function pickVersionTarget(
  versionMembers: OpenAIModel[],
  currentSubVariant: string | undefined,
  isSelectable?: SelectablePredicate,
): OpenAIModel | undefined {
  const gate =
    isSelectable && versionMembers.some(isSelectable)
      ? isSelectable
      : undefined;
  return preferSubVariant(versionMembers, currentSubVariant, gate);
}
