import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';
import { resolveWebSearchModel } from '@/lib/services/models/webSearchModel';

import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { isAllowedFoundryHost } from '@/lib/utils/shared/foundryHostAllowlist';
import { UserRegion } from '@/lib/utils/shared/region';

import { ToolResult } from './Tool';

import type OpenAI from 'openai';

/**
 * The Bing web-search executor: the native `web_search` tool on the Azure
 * OpenAI Responses API. One direct model call — no Foundry agent to
 * provision or maintain, no connection, no thread/run loop. Runs on the
 * user's region's Foundry project (only the query leaves the app) with the
 * deployment resolveWebSearchModel picks for that region. Module functions
 * (like the feed providers) so WebSearchTool needs no constructor
 * dependencies.
 */

/** Subset of the Responses API url_citation annotation we consume. */
export interface UrlCitationAnnotation {
  type: string; // 'url_citation'
  url: string;
  title?: string;
  start_index: number;
  end_index: number;
}

export interface ResponsesWebSearchParams {
  searchQuery: string;
  resultCount?: number;
  freshness?: 'day' | 'week' | 'month' | 'any';
  /**
   * Router's searchComprehensive: deep searches run with more reasoning so
   * the model can search agentically (open_page/find_in_page); surface
   * lookups stay on low effort for speed.
   */
  deep?: boolean;
  /**
   * The user's region: picks the Foundry project the search runs on and
   * the deployment it uses. EU users are always served from the EU.
   */
  region?: UserRegion | null;
  /**
   * The call's token usage, once known. A search is the user's spend like
   * any other model call (10-15k input tokens is typical: the model runs
   * several search rounds), so callers meter it — telemetry row, emissions
   * and token quota — exactly as they do an assessor call.
   */
  onUsage?: (
    usage: WebSearchUsage,
    modelId: string,
    region: UserRegion,
  ) => void;
  /** Aborts the Responses call (the enricher's search timeout). */
  signal?: AbortSignal;
}

export interface WebSearchUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** One output_text content part with its citation annotations. */
export interface CitedTextPart {
  text: string;
  annotations: UrlCitationAnnotation[];
}

// The Foundry project's OpenAI client exposes the Responses surface; cached
// per endpoint because construction imports SDKs and negotiates credentials.
const clientPromises = new Map<string, Promise<OpenAI>>();

async function getClient(endpoint: string): Promise<OpenAI> {
  let clientPromise = clientPromises.get(endpoint);
  if (!clientPromise) {
    clientPromise = (async () => {
      const aiProjects = await import('@azure/ai-projects');
      const { DefaultAzureCredential } = await import('@azure/identity');

      if (!isAllowedFoundryHost(endpoint)) {
        throw new Error(
          `Refusing to invoke Foundry against disallowed host: ${endpoint}`,
        );
      }

      const project = new aiProjects.AIProjectClient(
        endpoint,
        new DefaultAzureCredential(),
      );
      return (await project.getOpenAIClient()) as unknown as OpenAI;
    })();
    clientPromises.set(endpoint, clientPromise);
    // Don't cache failures: a transient credential/endpoint error would
    // otherwise make every later search rethrow the stale rejection.
    clientPromise.catch(() => {
      clientPromises.delete(endpoint);
    });
  }
  return clientPromise;
}

/**
 * The region a search runs in. EU users are always served from the EU;
 * everyone else from the US. (Mirrors resolveChatRegion's residency rule
 * for the one place a search query leaves the app.)
 */
function searchRegion(region: UserRegion | null | undefined): UserRegion {
  return region === 'EU' ? 'EU' : 'US';
}

/**
 * Converts Responses output_text parts + url_citation annotations into the
 * app's {text-with-[n]-markers, numbered citations} shape. Pure.
 *
 * - Numbers are assigned in order of first appearance (by end_index),
 *   deduped by URL; numbering continues across parts.
 * - `[n]` markers are inserted at each annotation's end_index, iterating
 *   DESCENDING so earlier indices stay valid. Annotation indices are per
 *   content part. Out-of-range indices are clamped.
 * - url_citation carries no date → `date: ''` (tolerated downstream; the
 *   enricher's citation handling reads url/number/title only).
 */
export function buildCitedSearchResult(parts: CitedTextPart[]): {
  text: string;
  citations: NonNullable<ToolResult['citations']>;
} {
  const numberByUrl = new Map<string, number>();
  const citations: NonNullable<ToolResult['citations']> = [];
  const outParts: string[] = [];

  for (const part of parts) {
    const anns = part.annotations
      .filter((a) => a.type === 'url_citation' && !!a.url)
      .sort((a, b) => a.end_index - b.end_index);

    for (const a of anns) {
      if (!numberByUrl.has(a.url)) {
        const number = numberByUrl.size + 1;
        numberByUrl.set(a.url, number);
        citations.push({
          number,
          title: a.title || a.url,
          url: a.url,
          date: '',
        });
      }
    }

    let text = part.text;
    for (let i = anns.length - 1; i >= 0; i--) {
      const a = anns[i];
      const idx = Math.max(0, Math.min(text.length, a.end_index));
      const marker = `[${numberByUrl.get(a.url)}]`;
      // Skip when the identical marker already sits at this position (two
      // annotations for the same URL at the same index would double it —
      // an earlier descending-pass insertion lands AT idx, so check both
      // sides).
      if (
        text.startsWith(marker, idx) ||
        text.slice(Math.max(0, idx - marker.length), idx) === marker
      ) {
        continue;
      }
      text = text.slice(0, idx) + marker + text.slice(idx);
    }
    outParts.push(text);
  }

  return { text: outParts.join('\n\n').trim(), citations };
}

/**
 * Runs one web search via the Responses API `web_search` tool and returns
 * the app-shaped digest. Throws on failure — WebSearchTool's top-level
 * catch degrades to the "search encountered an issue" note.
 */
export async function executeResponsesWebSearch(
  params: ResponsesWebSearchParams,
): Promise<ToolResult> {
  const { searchQuery, resultCount, freshness, deep, signal } = params;
  const region = searchRegion(params.region);
  const model = await resolveWebSearchModel(region);

  // Tuning rides the instruction text (same approach as the Foundry search
  // agent leg): the web_search tool itself takes no count/freshness params.
  const breadthInstruction = resultCount
    ? `Consult and cite up to ${resultCount} distinct, high-quality sources — do not pad with near-duplicates.\n`
    : '';
  const freshnessInstruction =
    freshness && freshness !== 'any'
      ? `Strongly prefer results published within the past ${freshness}; note publication dates of key sources.\n`
      : '';
  const input =
    `Search the live web NOW to satisfy the information need below, then write a concise, well-sourced summary. ` +
    `Cite a source for every claim. Do not ask for confirmation.\n` +
    breadthInstruction +
    freshnessInstruction +
    `If information is limited or not yet finalized, report the best current information with its source.\n\n` +
    `Information need: ${searchQuery}`;

  const client = await getClient(OfficeResolver.getFoundryEndpoint(region));
  const response = await withAzureRetry(
    () =>
      client.responses.create(
        {
          model,
          input,
          tools: [{ type: 'web_search' } as unknown as OpenAI.Responses.Tool],
          // 'minimal' is rejected alongside web_search on gpt-5.x; 'medium'
          // lets deep searches use agentic open_page/find_in_page rounds.
          reasoning: { effort: deep ? 'medium' : 'low' },
          store: false,
        },
        signal ? { signal } : undefined,
      ),
    { label: 'responses-web-search' },
  );

  const usage = response.usage;
  if (usage && params.onUsage) {
    const promptTokens = usage.input_tokens ?? 0;
    const completionTokens = usage.output_tokens ?? 0;
    params.onUsage(
      {
        promptTokens,
        completionTokens,
        totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
      },
      model,
      region,
    );
  }

  const parts: CitedTextPart[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content.type !== 'output_text') continue;
      parts.push({
        text: content.text,
        annotations: (
          (content.annotations ?? []) as unknown as UrlCitationAnnotation[]
        ).filter((a) => a.type === 'url_citation'),
      });
    }
  }

  return {
    ...buildCitedSearchResult(parts),
    // Which deployment answered — the tool record shows it ("via Bing
    // (gpt-5.4)"), and it is the only trace of the resolved model.
    metadata: { executor: `Bing (${model})` },
  };
}
