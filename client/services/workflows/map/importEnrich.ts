'use client';

/**
 * Filling in what an imported file left blank — the one place the model
 * touches imported points, and only on request.
 *
 * The use case: a clinic list arrives with names and GPS positions and
 * nothing else. The map can show it, but the legend is empty and every popup
 * is bare. Enrichment asks the model, given each name AND its stated
 * coordinates, for a category, a one-line description and the country —
 * and never for a position. Coordinates are the file's statements and stay
 * exactly as imported; only empty fields are filled. It is a model call, so
 * it costs tokens and shows on the impact badge like any other run.
 */
import { extractMapFeatures } from '@/client/services/workflows/map/mapExtraction';

import { MapFeature } from '@/types/workflow';

/** How many points travel per model call; keeps the prompt inside its budget. */
const BATCH_SIZE = 150;

export interface EnrichmentPatch {
  category?: string;
  description?: string;
  countryCode?: string;
}

/** True for a point that has something enrichment could fill. */
export function needsEnrichment(
  feature: Pick<MapFeature, 'category' | 'description' | 'countryCode'>,
): boolean {
  return !feature.category || !feature.description || !feature.countryCode;
}

function nameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

const INSTRUCTIONS =
  'Every location below is already placed; its coordinates are correct and must be returned exactly as given. ' +
  'For each one, supply a short category, a one-sentence description of what it is, and its ISO country code. ' +
  'Return only the listed locations — add nothing, merge nothing, and do not invent connections.';

/**
 * Asks the model for the missing fields of `features`, in batches. Returns
 * patches keyed by feature id containing ONLY fields that were empty.
 */
export async function enrichFeatures(
  features: readonly MapFeature[],
  options: { modelId?: string; conversationId?: string },
): Promise<Map<string, EnrichmentPatch>> {
  const patches = new Map<string, EnrichmentPatch>();
  const candidates = features.filter(needsEnrichment);
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const byName = new Map(batch.map((f) => [nameKey(f.name), f]));
    const sourceText = batch
      .map((f) => `- ${f.name} — latitude ${f.lat}, longitude ${f.lon}`)
      .join('\n');
    const result = await extractMapFeatures(
      { sourceText, instructions: INSTRUCTIONS },
      {
        existingNames: [],
        modelId: options.modelId,
        conversationId: options.conversationId,
      },
    );
    for (const found of result.features) {
      const target = byName.get(nameKey(found.name));
      if (!target) continue;
      const patch: EnrichmentPatch = {};
      if (!target.category && found.category) patch.category = found.category;
      if (!target.description && found.description)
        patch.description = found.description;
      if (!target.countryCode && found.countryCode)
        patch.countryCode = found.countryCode;
      if (Object.keys(patch).length > 0) patches.set(target.id, patch);
    }
  }
  return patches;
}

/** Applies patches; positions are untouched by construction. */
export function applyEnrichment(
  features: readonly MapFeature[],
  patches: ReadonlyMap<string, EnrichmentPatch>,
): MapFeature[] {
  return features.map((f) => {
    const patch = patches.get(f.id);
    return patch ? { ...f, ...patch } : f;
  });
}
