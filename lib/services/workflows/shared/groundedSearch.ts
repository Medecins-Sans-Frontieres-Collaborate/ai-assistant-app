import { Session } from 'next-auth';

import { ServiceContainer } from '@/lib/services/ServiceContainer';
import { executeResponsesWebSearch } from '@/lib/services/chat/tools/responsesWebSearch';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

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
 * The Foundry agent with Bing grounding (the original map-route path).
 * Mirrors ToolRouterEnricher.getAgentModelForSearch: the default search
 * agent must have a discovered agentId.
 */
export const bingAgentProvider: GroundedSearchProvider = {
  id: 'bing-agent',
  isAvailable: () => Boolean(OpenAIModels[OpenAIModelID.GPT_5_2]?.agentId),
  async search(query, user, options) {
    const model = OpenAIModels[OpenAIModelID.GPT_5_2];
    const service = ServiceContainer.getInstance().getAgentChatService();
    const result = await service.executeWebSearchTool({
      searchQuery: query,
      model,
      user,
      resultCount: options?.resultCount,
    });
    return { text: result.text, citations: result.citations };
  },
};

/** The native web_search tool on the Responses API — no agent needed. */
export const bingResponsesProvider: GroundedSearchProvider = {
  id: 'bing-responses',
  isAvailable: () => true,
  async search(query, _user, options) {
    const result = await executeResponsesWebSearch({
      searchQuery: query,
      resultCount: options?.resultCount,
    });
    return { text: result.text, citations: result.citations ?? [] };
  },
};

/**
 * Provider for the configured engine. Feed-only providers (news, gdelt,
 * google-news, combined) have no grounded-answer form, so they resolve to
 * the Bing agent exactly as the map route always did.
 */
export function resolveGroundedSearchProvider(): GroundedSearchProvider {
  return env.WEB_SEARCH_PROVIDER === 'bing-responses'
    ? bingResponsesProvider
    : bingAgentProvider;
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
