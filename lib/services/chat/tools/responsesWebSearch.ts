import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { isAllowedFoundryHost } from '@/lib/utils/shared/foundryHostAllowlist';

import { ToolResult } from './Tool';

import { env } from '@/config/environment';
import type OpenAI from 'openai';

/**
 * 'bing-responses' web-search executor: the native `web_search` tool on the
 * Azure OpenAI Responses API. Same Bing grounding as the Foundry search
 * agent ('bing-agent'), but a single direct model call instead of an agent
 * run — no agent provisioning, no thread/run loop, and typically a much
 * faster round-trip. Module functions (like the feed providers) so
 * WebSearchTool needs no new constructor dependencies.
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
}

/** One output_text content part with its citation annotations. */
export interface CitedTextPart {
  text: string;
  annotations: UrlCitationAnnotation[];
}

// The Foundry project's OpenAI client exposes the Responses surface; cached
// because construction imports SDKs and negotiates credentials.
let clientPromise: Promise<OpenAI> | null = null;

async function getClient(): Promise<OpenAI> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const aiProjects = await import('@azure/ai-projects');
      const { DefaultAzureCredential } = await import('@azure/identity');

      const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;
      if (!endpoint) {
        throw new Error(
          'bing-responses search requires AZURE_AI_FOUNDRY_ENDPOINT to be configured',
        );
      }
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
    // Don't cache failures: a transient credential/endpoint error would
    // otherwise make every later search rethrow the stale rejection.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
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
  const { searchQuery, resultCount, freshness, deep } = params;

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

  const client = await getClient();
  const response = await withAzureRetry(
    () =>
      client.responses.create({
        model: env.WEB_SEARCH_RESPONSES_MODEL,
        input,
        tools: [{ type: 'web_search' } as unknown as OpenAI.Responses.Tool],
        // 'minimal' is rejected alongside web_search on gpt-5.x; 'medium'
        // lets deep searches use agentic open_page/find_in_page rounds.
        reasoning: { effort: deep ? 'medium' : 'low' },
        store: false,
      }),
    { label: 'responses-web-search' },
  );

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

  return buildCitedSearchResult(parts);
}
