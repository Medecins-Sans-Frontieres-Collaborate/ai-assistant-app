import { OpenAIModel, getModelTier } from '@/types/openai';

/**
 * Version recency from the numeric versionLabel ("5.4" → 5.4, "4o" → 4,
 * "3.2" → 3.2). DEFAULT_MODEL_ORDER can't be used for this: it is display
 * PRIORITY, which ranks e.g. gpt-4.1 above gpt-5.4.
 */
export function versionRank(model: Pick<OpenAIModel, 'versionLabel'>): number {
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
