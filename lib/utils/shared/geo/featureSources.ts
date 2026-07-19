import { MapFeature, MapSourceRecord } from '@/types/workflow';

/**
 * Resolving a feature back to the material it came from.
 *
 * Every extraction run records a source (a pasted block, a file, a search, a
 * fetched page) and stamps its id onto the features it produced. Surfacing
 * that link is what makes a mapped point checkable: a reader can see which
 * document put a marker on Goma, and open it when the source was a URL.
 * Features from before source stamping simply resolve to null.
 */

export type SourceIndex = Map<string, MapSourceRecord>;

export function buildSourceIndex(
  sources: MapSourceRecord[] | undefined,
): SourceIndex {
  return new Map((sources ?? []).map((source) => [source.id, source]));
}

export function featureSource(
  feature: MapFeature,
  index: SourceIndex,
): MapSourceRecord | null {
  if (!feature.sourceId) return null;
  return index.get(feature.sourceId) ?? null;
}

/**
 * The openable link for a source, if it has one. Only fetched pages carry a
 * URL; files and pasted text are named but not linkable, and a search
 * records its query rather than a single page.
 */
export function sourceHref(source: MapSourceRecord | null): string | null {
  if (!source?.url) return null;
  // Defence in depth: only http(s) links are ever rendered as anchors, so a
  // stored `javascript:` URL can never become a clickable payload.
  try {
    const parsed = new URL(source.url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? source.url
      : null;
  } catch {
    return null;
  }
}
