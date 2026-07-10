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
 * The version that fronts a series row: the current selection when it's in
 * this series, else the FEATURED (recommended) version, else the newest
 * non-legacy, else the newest. Featured beats newest on purpose — the row's
 * face should be the vetted default, with newer versions one click away in
 * the details panel.
 */
export function seriesRepresentative(
  versions: OpenAIModel[],
  selectedModelId?: string,
): OpenAIModel | undefined {
  return (
    versions.find((v) => v.id === selectedModelId) ??
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
 * Distinct variants among the given family members, in order of first
 * appearance — so member order (display priority) decides the segment order
 * (e.g. Standard → Mini → Nano, Opus → Sonnet → Haiku).
 */
export function getFamilyVariants(members: OpenAIModel[]): FamilyVariant[] {
  const byKey = new Map<string, FamilyVariant>();
  for (const m of members) {
    const key = m.variant ?? '';
    const existing = byKey.get(key);
    if (existing) {
      existing.members.push(m);
    } else {
      byKey.set(key, { key, label: m.variantLabel ?? '', members: [m] });
    }
  }
  return [...byKey.values()];
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
