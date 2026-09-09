import { Session } from 'next-auth';

import { parseMetadataFromContent } from '@/lib/utils/app/metadata';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { AIFoundryAgentHandler } from './AIFoundryAgentHandler';

import {
  scanStreamEvents,
  stripIncompleteStreamMarkers,
} from '@/lib/streamMarkers';
import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Request for executing a web search tool via AI Foundry agent.
 */
export interface WebSearchToolRequest {
  searchQuery: string;
  model: OpenAIModel;
  user: Session['user'];
  /** Maximum distinct sources to request (shapes the agent instruction). */
  resultCount?: number;
  /** Recency preference ('any'/absent = no preference). */
  freshness?: 'day' | 'week' | 'month' | 'any';
  /**
   * Receives the inner Foundry stream's AGENT_ACTIVITY payloads as they
   * arrive, so the outer response's loader can show live progress phases.
   */
  onActivity?: (key: string, params?: Record<string, string>) => void;
}

/**
 * Response from web search tool execution.
 */
export interface WebSearchToolResponse {
  text: string;
  citations: Array<{
    number: number;
    title: string;
    url: string;
    date: string;
  }>;
}

/**
 * AgentChatService
 *
 * Handles execution of AI Foundry agents as tools (specifically for web search).
 * This is different from full agent-based chat - here we use agents to execute
 * specific tool functions and return structured results.
 */
export class AgentChatService {
  private aiFoundryAgentHandler: AIFoundryAgentHandler;
  private tracer = trace.getTracer('agent-chat-service');

  constructor() {
    this.aiFoundryAgentHandler = new AIFoundryAgentHandler();
  }

  /**
   * Executes a web search using an AI Foundry agent.
   *
   * This uses the agent ONLY for the search query, not the full conversation,
   * to preserve user privacy.
   *
   * @param request - Web search request with query, model, and user
   * @returns Search results with text and citations
   */
  async executeWebSearchTool(
    request: WebSearchToolRequest,
  ): Promise<WebSearchToolResponse> {
    return await this.tracer.startActiveSpan(
      'agent.web_search',
      {
        attributes: {
          'search.query': request.searchQuery,
          'search.query_length': request.searchQuery.length,
          'search.model': request.model.id,
          'user.id': request.user.id,
          'user.email': request.user.mail || 'unknown',
          'user.department': request.user.department || 'unknown',
          'user.company': request.user.companyName || 'unknown',
        },
      },
      async (span) => {
        try {
          const { searchQuery, model, user, resultCount, freshness } = request;

          console.log(
            `[AgentChatService] Executing web search for query: "${sanitizeForLog(searchQuery)}" (sources: ${resultCount ?? 'default'}, freshness: ${freshness ?? 'any'})`,
          );

          // Tuning rides the instruction: the Bing tool's own count/freshness
          // parameters live on the Foundry AGENT DEFINITION (infra config),
          // so per-request preferences are expressed to the agent's model,
          // which shapes its search calls and its summary accordingly.
          const freshnessInstruction =
            freshness && freshness !== 'any'
              ? `Strongly prefer results published within the past ${freshness}; note the publication date of key sources. `
              : '';
          const breadthInstruction = resultCount
            ? `Consult and cite up to ${resultCount} distinct, high-quality sources — do not pad with near-duplicates. `
            : '';

          // The text below is an INFORMATION NEED, not a literal search
          // string — it may be a raw user prompt (forced mode) or a router-
          // generated phrase. The agent's model formulates the actual search
          // queries: short keyword queries, broadened + retried when a
          // search comes back empty. Pasting a 15-word run-on into the
          // search tool verbatim is how "no results" happens.
          const searchInstruction =
            `Below is the user's information need. Search the live web NOW to satisfy it, and cite your sources. ` +
            `Do not ask for confirmation and do not reply that you need to search — search immediately and report what you find.\n` +
            `How to search:\n` +
            `- Derive 1-3 CONCISE search queries yourself (2-6 keywords each, one topic per query, no question phrasing). Never paste the information need verbatim as a query.\n` +
            `- If a search returns nothing useful, simplify to fewer, broader terms and search again before giving up.\n` +
            `- ${breadthInstruction || 'Consult distinct, high-quality sources — do not pad with near-duplicates. '}\n` +
            (freshnessInstruction ? `- ${freshnessInstruction}\n` : '') +
            `If information is limited or not yet finalized, report the best current information available with its source.\n\n` +
            `Information need: ${searchQuery}`;

          const searchMessages: Message[] = [
            {
              role: 'user' as const,
              content: searchInstruction,
              messageType: undefined,
            },
          ];

          // Execute the agent with the search query
          const response = await this.aiFoundryAgentHandler.handleAgentChat(
            model.id,
            model,
            searchMessages,
            0.3, // Lower temperature for factual search
            user,
            undefined, // No botId for search
            undefined, // No threadId - each search is independent
            undefined, // No per-request credential (service-level auth)
            undefined, // No per-request endpoint (default Foundry endpoint)
            undefined, // No approvalResponses
            { ephemeral: true }, // Delete the Azure conversation after the search.
          );

          // Parse the streaming response to extract text and citations
          const { text, citations } = await this.parseAgentResponse(
            response,
            request.onActivity,
          );

          console.log(
            `[AgentChatService] Web search completed: ${text.length} chars, ${citations.length} citations`,
          );
          console.log(
            `[AgentChatService] Web search response text:`,
            text.substring(0, 200),
          );

          span.setAttribute('search.result_length', text.length);
          span.setAttribute('search.citations_count', citations.length);
          span.setStatus({ code: SpanStatusCode.OK });

          return { text, citations };
        } catch (error) {
          console.error('[AgentChatService] Web search failed:', error);
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Parses the streaming agent response to extract text and citations.
   *
   * Structured stream markers (AGENT_ACTIVITY etc.) are lifted out with the
   * forward-only scanner: activity payloads are forwarded to `onActivity`
   * for live progress, and NO marker wire-format ever reaches the returned
   * text (which gets merged into a model prompt). The terminal metadata
   * block is parsed with the shared parser, which also handles blocks split
   * across network reads — the old per-chunk regex missed those.
   */
  private async parseAgentResponse(
    response: Response,
    onActivity?: (key: string, params?: Record<string, string>) => void,
  ): Promise<{
    text: string;
    citations: Array<{
      number: number;
      title: string;
      url: string;
      date: string;
    }>;
  }> {
    return await this.tracer.startActiveSpan(
      'agent.parse_response',
      async (span) => {
        try {
          if (!response.body) {
            throw new Error('Response body is null');
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let raw = '';
          let cursor = 0;
          let display = '';

          const consumeScan = () => {
            const scan = scanStreamEvents(raw, cursor);
            for (const event of scan.events) {
              if (event.type === 'agent_activity') {
                onActivity?.(event.payload.key, event.payload.params);
              }
              // Other marker kinds (tool records, consent) are stripped —
              // they must never leak into prompt text.
            }
            display += scan.displayDelta;
            cursor = scan.nextIndex;
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              raw += decoder.decode(value, { stream: true });
              consumeScan();
            }
            const tail = decoder.decode();
            if (tail) {
              raw += tail;
            }
            consumeScan();

            // A dangling half-marker at the very end (stream cut mid-tag)
            // must not leak either.
            display = stripIncompleteStreamMarkers(display);

            const parsed = parseMetadataFromContent(display);
            const citations = (parsed.citations ?? []) as Array<{
              number: number;
              title: string;
              url: string;
              date: string;
            }>;

            span.setAttribute('parse.text_length', parsed.content.length);
            span.setAttribute('parse.citations_count', citations.length);
            span.setStatus({ code: SpanStatusCode.OK });

            return { text: parsed.content.trim(), citations };
          } finally {
            reader.releaseLock();
          }
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
