import {
  Message,
  ToolRouterRequest,
  ToolRouterResponse,
  ToolType,
} from '@/types/chat';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { OpenAI } from 'openai';

/**
 * ToolRouterService
 *
 * Determines which tools are needed for a given message using GPT-4.1.
 * Uses a lightweight model to intelligently decide when web search is beneficial.
 */
export class ToolRouterService {
  private tracer = trace.getTracer('tool-router-service');

  constructor(private openAIClient: OpenAI) {}

  /**
   * Determines which tools are needed for the current message.
   *
   * @param request - ToolRouterRequest with messages and forceWebSearch flag
   * @returns ToolRouterResponse with tools array and optional searchQuery
   */
  async determineTool(request: ToolRouterRequest): Promise<ToolRouterResponse> {
    return await this.tracer.startActiveSpan(
      'tool_router.determine',
      {
        attributes: {
          'tool_router.force_web_search': request.forceWebSearch || false,
          'tool_router.message_length': request.currentMessage.length,
        },
      },
      async (span) => {
        try {
          const { currentMessage, forceWebSearch } = request;

          // If forceWebSearch is true, always return web_search
          if (forceWebSearch) {
            console.log(
              '[ToolRouterService] Force web search enabled, skipping AI decision',
            );
            span.setAttribute('tool_router.decision', 'forced_web_search');
            span.setStatus({ code: SpanStatusCode.OK });
            return {
              tools: ['web_search'] as ToolType[],
              searchQuery: currentMessage,
              reasoning: 'Forced web search mode',
            };
          }

          // Use an efficient model to determine if web search is needed
          // This uses the standard OpenAI client which can route to any model
          try {
            const systemPrompt = `You are a tool router that determines if web search is needed.

Analyze the user's message in the context of the conversation and determine if it requires current, real-time information from the web.

Web search is needed for:
- Current events, news, recent developments
- Real-time data (weather, stock prices, scores)
- Recent information (released after 2024)
- Specific facts that change frequently
- Comparisons requiring current data

Web search is NOT needed for:
- General knowledge, concepts, explanations
- Code writing, debugging, tutorials
- Mathematical calculations
- Creative writing, brainstorming
- Personal advice, opinions
- Questions about uploaded files or images

IMPORTANT: Always provide searchQuery in your response:
- If needsWebSearch is true, provide an optimized search query based on the full conversation context
- If needsWebSearch is false, provide an empty string`;

            // Include recent conversation history for context-aware decisions
            // Take last 3 message pairs (6 messages max) to keep it efficient
            const recentMessages = this.getRecentMessages(request.messages, 6);

            // Build messages array with conversation context
            const conversationMessages = [
              { role: 'system' as const, content: systemPrompt },
              ...recentMessages.map((msg) => ({
                role: msg.role as 'user' | 'assistant' | 'system',
                content:
                  typeof msg.content === 'string'
                    ? msg.content
                    : this.extractTextContent(msg.content),
              })),
            ];

            console.log('[ToolRouterService] Using conversation context:', {
              messagesCount: recentMessages.length,
              lastMessage: currentMessage.substring(0, 100),
            });

            // Use gpt-5-mini for efficient tool routing decisions
            // This works with any OpenAI-compatible endpoint
            // Note: gpt-5-mini only supports default temperature (1), custom values not allowed
            const response = await this.openAIClient.chat.completions.create({
              model: 'gpt-5-mini',
              messages: conversationMessages,
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'tool_router_response',
                  strict: true,
                  schema: {
                    type: 'object',
                    properties: {
                      needsWebSearch: {
                        type: 'boolean',
                        description:
                          'Whether web search is needed for this query',
                      },
                      searchQuery: {
                        type: 'string',
                        description:
                          'Optimized search query if web search is needed, empty string otherwise',
                      },
                      reasoning: {
                        type: 'string',
                        description: 'Brief explanation of the decision',
                      },
                    },
                    required: ['needsWebSearch', 'searchQuery', 'reasoning'],
                    additionalProperties: false,
                  },
                },
              },
            });

            const result = JSON.parse(
              response.choices[0].message.content || '{}',
            );

            console.log('[ToolRouterService] AI decision:', result);

            span.setAttribute(
              'tool_router.needs_web_search',
              result.needsWebSearch,
            );
            span.setAttribute('tool_router.reasoning', result.reasoning);
            span.setStatus({ code: SpanStatusCode.OK });

            if (result.needsWebSearch) {
              span.setAttribute('tool_router.search_query', result.searchQuery);
              return {
                tools: ['web_search'] as ToolType[],
                searchQuery: result.searchQuery || currentMessage,
                reasoning: result.reasoning || 'Web search recommended by AI',
              };
            }

            return {
              tools: [] as ToolType[],
              reasoning: result.reasoning || 'No tools needed',
            };
          } catch (error) {
            console.error('[ToolRouterService] Error determining tool:', error);
            span.recordException(error as Error);
            // Fail gracefully - no tools
            return {
              tools: [],
              reasoning: 'Error determining tools, proceeding without search',
            };
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

  /**
   * Gets the most recent messages from the conversation for context.
   * Limits to maxMessages to keep the tool routing efficient.
   */
  private getRecentMessages(
    messages: Message[],
    maxMessages: number,
  ): Message[] {
    if (messages.length <= maxMessages) {
      return messages;
    }
    return messages.slice(-maxMessages);
  }

  /**
   * Extracts text content from complex message content structures.
   * Handles string, array, and object content types.
   */
  private extractTextContent(content: any): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textParts = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text);
      return textParts.join('\n');
    }

    if (content && typeof content === 'object' && 'text' in content) {
      return content.text;
    }

    return '[non-text content]';
  }
}
