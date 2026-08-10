import { NamedConnection } from '@/lib/utils/shared/geo/connections';

import { MapFeature } from '@/types/workflow';

/** One grounded-search citation returned by the extraction route. */
export interface ExtractionCitation {
  number: number;
  title: string;
  url: string;
}

export interface ExtractionResult {
  /** Route features carry no ids — the caller assigns id + sourceId. */
  features: Array<Omit<MapFeature, 'id' | 'sourceId'>>;
  /** Name-referenced connections, resolved to ids by the caller. */
  connections: NamedConnection[];
  citations: ExtractionCitation[];
  truncatedSource: boolean;
}

/**
 * Transport core of map feature extraction (POST /api/workflows/map),
 * shared by the map workspace and the admin dataset editor. Lifted verbatim
 * from MapWorkspace.runExtraction — everything conversation-specific (store
 * writes, rail messages, naming) stays with the callers.
 */
export async function extractMapFeatures(
  input: { sourceText: string } | { searchQuery: string },
  options: { existingNames: string[]; modelId?: string },
): Promise<ExtractionResult> {
  const response = await fetch('/api/workflows/map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...input,
      existingNames: options.existingNames,
      modelId: options.modelId,
    }),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.success) {
    throw new Error(parsed?.error || `Request failed (${response.status})`);
  }

  return {
    features: parsed.data.features as Array<
      Omit<MapFeature, 'id' | 'sourceId'>
    >,
    connections: (parsed.data.connections ?? []) as NamedConnection[],
    citations: (parsed.data.sources ?? []) as ExtractionCitation[],
    truncatedSource: Boolean(parsed.data.truncatedSource),
  };
}
