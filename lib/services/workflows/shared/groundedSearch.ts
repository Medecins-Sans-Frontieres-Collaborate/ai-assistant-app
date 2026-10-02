import { Session } from 'next-auth';

import { executeResponsesWebSearch } from '@/lib/services/chat/tools/responsesWebSearch';

import { WorkflowCallUsage } from '@/types/workflowUsage';

import { env } from '@/config/environment';

/**
 * Grounded web search behind one seam (docs/DOCUMENT_FILL_ASSESSMENT.md
 * §5a), shared by the map and form workflows. A provider returns the
 * grounded answer text plus citations; which provider runs is decided by
 * `WEB_SEARCH_PROVIDER`, so swapping the engine is one implementation and
 * one enum value with no change in the workflow routes.
 *
 * Privacy posture is the workflows' own: only the query leaves the app —
 * never the conversation, the template, or the user's sources.
 */

export interface GroundedSearchCitation {
  number: number;
  title: string;
  url: string;
  date: string;
}

export interface GroundedSearchResult {
  text: string;
  citations: GroundedSearchCitation[];
  /** The model call behind the answer, for the workflow's usage ledger. */
  usage?: WorkflowCallUsage;
}

export interface GroundedSearchProvider {
  id: string;
  /** False when the environment lacks what the provider needs. */
  isAvailable(): boolean;
  search(
    query: string,
    user: Session['user'],
    options?: { resultCount?: number },
  ): Promise<GroundedSearchResult>;
}

/**
 * Bing through the Responses API's native web_search tool, on the user's
 * region — the one grounded-answer provider. No Foundry agent: the
 * deployment is resolved per region by lib/services/models/webSearchModel.ts
 * (the policy default, skipping anything that is retiring), so nothing here
 * names a model or needs updating when one is retired.
 */
export const bingProvider: GroundedSearchProvider = {
  id: 'bing',
  isAvailable: () =>
    Boolean(
      env.AZURE_AI_FOUNDRY_ENDPOINT ||
      env.AZURE_AI_FOUNDRY_ENDPOINT_US ||
      env.AZURE_AI_FOUNDRY_ENDPOINT_EU,
    ),
  async search(query, user, options) {
    let usage: WorkflowCallUsage | undefined;
    const result = await executeResponsesWebSearch({
      searchQuery: query,
      resultCount: options?.resultCount,
      region: user?.region,
      onUsage: (spent, modelId) => {
        usage = { label: 'search', modelId, ...spent };
      },
    });
    return { text: result.text, citations: result.citations ?? [], usage };
  },
};

/**
 * Provider for the configured engine. Digest-only providers (searxng —
 * also the unset default — news, gdelt, google-news, combined) have no
 * grounded-answer form yet, so every configuration resolves to Bing, as the
 * map route always did.
 */
export function resolveGroundedSearchProvider(): GroundedSearchProvider {
  return bingProvider;
}

/**
 * Runs the configured grounded search; null when no provider is available
 * in this environment (the routes answer SEARCH_UNAVAILABLE).
 */
export async function runGroundedSearch(
  query: string,
  user: Session['user'],
  options?: { resultCount?: number },
): Promise<GroundedSearchResult | null> {
  const provider = resolveGroundedSearchProvider();
  if (!provider.isAvailable()) return null;
  return provider.search(query, user, options);
}

/** The citations rendered as the "Sources:" block appended to material. */
export function formatCitationList(
  citations: GroundedSearchCitation[],
): string {
  if (citations.length === 0) return '';
  return `\n\nSources:\n${citations
    .map(
      (c) =>
        `[${c.number}] ${c.title} — ${c.url}${c.date ? ` (${c.date})` : ''}`,
    )
    .join('\n')}`;
}
