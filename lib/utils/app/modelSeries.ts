import { OpenAIModel, getModelTier } from '@/types/openai';

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
 * The model that fronts a family row: the current selection when it's in
 * this family, else the best-ranked `defaultRank` member (ties go to the
 * newest, since `versions` arrives newest-first — so "rank 1 on every
 * Sonnet" means "latest available Sonnet"), else the FEATURED version, else
 * the newest non-legacy, else the newest. This is also what clicking the
 * row selects, i.e. the family's default.
 */
export function seriesRepresentative(
  versions: OpenAIModel[],
  selectedModelId?: string,
): OpenAIModel | undefined {
  const selected = versions.find((v) => v.id === selectedModelId);
  if (selected) return selected;

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

/**
 * The model to select when the user switches to another variant: the same
 * versionLabel within that variant when it exists (keep the user's version),
 * else the variant's representative (featured → newest non-legacy → newest).
 */
export function pickVariantTarget(
  variantMembers: OpenAIModel[],
  currentVersionLabel: string | undefined,
): OpenAIModel | undefined {
  return (
    (currentVersionLabel !== undefined
      ? variantMembers.find((m) => m.versionLabel === currentVersionLabel)
      : undefined) ?? seriesRepresentative(variantMembers)
  );
}
