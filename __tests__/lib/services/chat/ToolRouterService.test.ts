/**
 * Unit Tests for ToolRouterService
 *
 * Tests the intelligent tool routing logic that determines when web search
 * is needed for user queries.
 */
import { ToolRouterService } from '@/lib/services/chat/ToolRouterService';

import { Message, MessageType } from '@/types/chat';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock OpenTelemetry
vi.mock('@opentelemetry/api', () => ({
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
  trace: {
    getTracer: () => ({
      startActiveSpan: (name: string, options: any, fn: (span: any) => any) => {
        // Create a mock span
        const mockSpan = {
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          recordException: vi.fn(),
          end: vi.fn(),
        };
        // Execute the function with the mock span
        return fn(mockSpan);
      },
    }),
  },
}));

describe('ToolRouterService', () => {
  let service: ToolRouterService;
  let mockOpenAIClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock OpenAI client
    mockOpenAIClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };

    service = new ToolRouterService(mockOpenAIClient);
  });

  describe('determineTool', () => {
    describe('with forceWebSearch enabled', () => {
      it('should always return web_search tool without calling AI', async () => {
        const request = {
          messages: [
            {
              role: 'user' as const,
              content: 'What is 2+2?',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'What is 2+2?',
          forceWebSearch: true,
        };

        const result = await service.determineTool(request);

        expect(result.tools).toEqual(['web_search']);
        expect(result.searchQuery).toBe('What is 2+2?');
        expect(result.reasoning).toBe('Forced tool mode');
        expect(mockOpenAIClient.chat.completions.create).not.toHaveBeenCalled();
      });

      it('should use forceWebSearch for any message type', async () => {
        const request = {
          messages: [
            {
              role: 'user' as const,
              content: 'Help me debug this code',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'Help me debug this code',
          forceWebSearch: true,
        };

        const result = await service.determineTool(request);

        expect(result.tools).toEqual(['web_search']);
        expect(result.searchQuery).toBe('Help me debug this code');
        expect(mockOpenAIClient.chat.completions.create).not.toHaveBeenCalled();
      });
    });

    describe('AI decision logic', () => {
      it('should determine web search is needed for current events', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: true,
                  searchQuery: 'latest news about AI developments 2025',
                  reasoning: 'Query asks for current events',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: "What's happening with AI today?",
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: "What's happening with AI today?",
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        expect(result.tools).toEqual(['web_search']);
        expect(result.searchQuery).toBe(
          'latest news about AI developments 2025',
        );
        // The `reasoning` field was dropped from the schema (saved tokens);
        // the service returns a stable internal reason string instead.
        expect(result.reasoning).toBe('Tools recommended by AI');
        expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalled();
      });

      it('maps fan-out queries: primary first, blanks/dupes dropped, capped at 5', async () => {
        mockOpenAIClient.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: true,
                  searchQuery: 'france strikes 2026',
                  searchRecency: 'week',
                  searchComprehensive: true,
                  additionalSearchQueries: [
                    'germany rail dispute 2026',
                    '',
                    'france strikes 2026',
                    'italy port workers 2026',
                    'spain farmers 2026',
                    'portugal teachers 2026',
                  ],
                }),
              },
            },
          ],
        });

        const result = await service.determineTool({
          messages: [],
          currentMessage: 'compare the european labor disputes',
        });

        expect(result.searchQuery).toBe('france strikes 2026');
        expect(result.searchQueries).toEqual([
          'france strikes 2026',
          'germany rail dispute 2026',
          'italy port workers 2026',
          'spain farmers 2026',
          'portugal teachers 2026',
        ]);
      });

      it('returns a single-entry query list when no extra aspects exist', async () => {
        mockOpenAIClient.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: true,
                  searchQuery: 'india protests 2026',
                  searchRecency: 'week',
                  searchComprehensive: false,
                  additionalSearchQueries: [],
                }),
              },
            },
          ],
        });

        const result = await service.determineTool({
          messages: [],
          currentMessage: 'india protests?',
        });

        expect(result.searchQueries).toEqual(['india protests 2026']);
      });

      it('classifies follow-ups on prior citations independently of needsWebSearch', async () => {
        mockOpenAIClient.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  searchRecency: 'none',
                  searchComprehensive: false,
                  searchFollowUp: true,
                }),
              },
            },
          ],
        });

        const result = await service.determineTool({
          messages: [],
          currentMessage: 'What did the Reuters article say about that?',
          hasPriorSearchCitations: true,
        });

        // No fresh search, but the follow-up flag comes back so the
        // enricher can fetch the cited articles.
        expect(result.tools).toEqual([]);
        expect(result.searchFollowUp).toBe(true);

        // The schema only carries searchFollowUp when it was offered.
        const call =
          mockOpenAIClient.chat.completions.create.mock.calls.at(-1)![0];
        expect(
          call.response_format.json_schema.schema.properties.searchFollowUp,
        ).toBeDefined();
        expect(call.messages[0].content).toContain('searchFollowUp');
      });

      it('never reports searchFollowUp without prior citations offered', async () => {
        mockOpenAIClient.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: true,
                  searchQuery: 'india protests',
                  searchRecency: 'week',
                  searchComprehensive: false,
                  // Hallucinated: the field was not in the schema.
                  searchFollowUp: true,
                }),
              },
            },
          ],
        });

        const result = await service.determineTool({
          messages: [],
          currentMessage: 'India protests?',
          hasPriorSearchCitations: false,
        });

        expect(result.searchFollowUp).toBe(false);
        const call =
          mockOpenAIClient.chat.completions.create.mock.calls.at(-1)![0];
        expect(
          call.response_format.json_schema.schema.properties.searchFollowUp,
        ).toBeUndefined();
      });

      it('instructs the model to default to no-search when the user provided their own content', async () => {
        mockOpenAIClient.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  searchRecency: 'none',
                  searchComprehensive: false,
                }),
              },
            },
          ],
        });

        const result = await service.determineTool({
          messages: [],
          currentMessage:
            'Summarize this article about the 2026 election\n\n[File: article.pdf]\n...',
          hasUserProvidedContent: true,
        });

        expect(result.tools).toEqual([]);
        const call =
          mockOpenAIClient.chat.completions.create.mock.calls.at(-1)![0];
        const systemPrompt = call.messages[0].content;
        expect(systemPrompt).toContain(
          'The user supplied their own source material this turn',
        );
        expect(systemPrompt).toContain('Default to needsWebSearch=false');
        expect(systemPrompt).toContain('EXPLICITLY asks to search the web');
      });

      it('still searches provided-content turns when the model reports an explicit request', async () => {
        mockOpenAIClient.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: true,
                  searchQuery: 'fusion energy milestones 2026',
                  searchRecency: 'week',
                  searchComprehensive: false,
                  additionalSearchQueries: [],
                }),
              },
            },
          ],
        });

        const result = await service.determineTool({
          messages: [],
          currentMessage:
            'Search the web for recent fusion news and compare it with this paper\n\n[File: paper.pdf]\n...',
          hasUserProvidedContent: true,
        });

        // The instruction is a default, not a hard gate — an explicit
        // in-message search request still routes to web_search.
        expect(result.tools).toEqual(['web_search']);
        expect(result.searchQuery).toBe('fusion energy milestones 2026');
      });

      it('omits the provided-content instruction when the flag is not set', async () => {
        mockOpenAIClient.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  searchRecency: 'none',
                  searchComprehensive: false,
                }),
              },
            },
          ],
        });

        await service.determineTool({
          messages: [],
          currentMessage: 'What is a monad?',
        });

        const call =
          mockOpenAIClient.chat.completions.create.mock.calls.at(-1)![0];
        expect(call.messages[0].content).not.toContain(
          'supplied their own source material',
        );
      });

      it('should determine web search is NOT needed for general knowledge', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  reasoning:
                    'General knowledge question about mathematics, no current data needed',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: 'What is the quadratic formula?',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'What is the quadratic formula?',
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        expect(result.tools).toEqual([]);
        // `reasoning` is no longer round-tripped from the model; the service
        // returns a stable internal string instead.
        expect(result.reasoning).toBe('No tools needed');
      });

      it('should determine web search is NOT needed for code questions', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  reasoning: 'Code writing task, no web search required',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: 'Write a function to sort an array',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'Write a function to sort an array',
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        expect(result.tools).toEqual([]);
      });

      it('should use conversation context for decision making', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: true,
                  searchQuery: 'current weather in San Francisco',
                  reasoning: 'Follow-up question requires current weather data',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: "What's the weather like?",
              messageType: MessageType.TEXT,
            },
            {
              role: 'assistant' as const,
              content: 'Where are you located?',
              messageType: MessageType.TEXT,
            },
            {
              role: 'user' as const,
              content: 'San Francisco',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'San Francisco',
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        expect(result.tools).toEqual(['web_search']);
        expect(result.searchQuery).toBe('current weather in San Francisco');

        // Verify the AI was called with conversation context
        const callArgs = mockOpenAIClient.chat.completions.create.mock.calls[0];
        expect(callArgs[0].messages.length).toBeGreaterThan(1); // Should include context
      });

      it('should limit conversation context to last 6 messages', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  reasoning: 'No search needed',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        // Create 10 messages (should only use last 6 + system prompt)
        const manyMessages: Message[] = Array.from({ length: 10 }, (_, i) => ({
          role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `Message ${i}`,
          messageType: MessageType.TEXT,
        }));

        const request = {
          messages: manyMessages,
          currentMessage: 'Latest message',
          forceWebSearch: false,
        };

        await service.determineTool(request);

        const callArgs = mockOpenAIClient.chat.completions.create.mock.calls[0];
        // Should be: 1 system prompt + max 6 recent messages = 7 total
        expect(callArgs[0].messages.length).toBeLessThanOrEqual(7);
      });
    });

    describe('complex message content handling', () => {
      it('should extract text from array content', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  reasoning: 'No search needed',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: 'Analyze this image' },
                {
                  type: 'image_url' as const,
                  image_url: {
                    url: 'http://example.com/img.jpg',
                    detail: 'auto' as const,
                  },
                },
              ],
              messageType: MessageType.IMAGE,
            },
          ],
          currentMessage: 'Analyze this image',
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        expect(result).toBeDefined();
        // Verify the service was able to extract text content
        expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalled();
      });

      it('should extract text from multiple text parts in array', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  reasoning: 'No search needed',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: 'Part 1' },
                { type: 'text' as const, text: 'Part 2' },
              ],
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'Part 1\nPart 2',
          forceWebSearch: false,
        };

        await service.determineTool(request);

        // Verify extraction worked by checking the call was made
        expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should handle API errors gracefully', async () => {
        mockOpenAIClient.chat.completions.create.mockRejectedValue(
          new Error('API error'),
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: 'Test message',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'Test message',
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        // Should fail gracefully and return no tools
        expect(result.tools).toEqual([]);
        expect(result.reasoning).toBe(
          'Error determining tools, proceeding without search',
        );
      });

      it('should handle malformed JSON responses', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: 'invalid json',
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: 'Test message',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'Test message',
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        // Should handle error and return no tools
        expect(result.tools).toEqual([]);
      });

      it('should handle empty response content', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: null,
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: 'Test message',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'Test message',
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        // Should handle gracefully
        expect(result.tools).toEqual([]);
      });

      it('should use fallback searchQuery if AI provides empty query when search is needed', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: true,
                  searchQuery: '', // Empty search query
                  reasoning: 'Search needed',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: "What's the weather?",
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: "What's the weather?",
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        expect(result.tools).toEqual(['web_search']);
        // Should use the original message as fallback
        expect(result.searchQuery).toBe("What's the weather?");
      });
    });

    describe('model configuration', () => {
      it('should use gpt-5.4-nano model for tool routing', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  reasoning: 'No search needed',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: 'Test query',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'Test query',
          forceWebSearch: false,
        };

        await service.determineTool(request);

        const callArgs = mockOpenAIClient.chat.completions.create.mock.calls[0];
        expect(callArgs[0].model).toBe('gpt-5.4-nano');
      });

      it('should use structured JSON output with strict schema', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  reasoning: 'No search needed',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: 'Test query',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'Test query',
          forceWebSearch: false,
        };

        await service.determineTool(request);

        const callArgs = mockOpenAIClient.chat.completions.create.mock.calls[0];
        // Schema was simplified for latency: `reasoning` field was dropped
        // (it was only used for debug logging and consumed output tokens).
        expect(callArgs[0].response_format).toEqual({
          type: 'json_schema',
          json_schema: {
            name: 'tool_router_response',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                needsWebSearch: {
                  type: 'boolean',
                  description: 'Whether web search is needed for this query',
                },
                searchQuery: {
                  type: 'string',
                  description:
                    'Concise search-engine query (3-8 keywords, one topic, no question words) if web search is needed, empty string otherwise',
                },
                searchRecency: {
                  type: 'string',
                  enum: ['day', 'week', 'month', 'none'],
                  description:
                    'How recent results must be when searching; "none" when age does not matter',
                },
                searchComprehensive: {
                  type: 'boolean',
                  description:
                    'Whether the question wants breadth (many sources) rather than a single fact',
                },
                additionalSearchQueries: {
                  type: 'array',
                  items: { type: 'string' },
                  maxItems: 4,
                  description:
                    'Usually empty. Extra queries ONLY for clearly separable aspects one query cannot cover (max 4)',
                },
              },
              required: [
                'needsWebSearch',
                'searchQuery',
                'searchRecency',
                'searchComprehensive',
                'additionalSearchQueries',
              ],
              additionalProperties: false,
            },
          },
        });
        // Latency-tuning params should be present.
        expect(callArgs[0].reasoning_effort).toBe('minimal');
        expect(callArgs[0].max_completion_tokens).toBe(200);
      });
    });

    describe('system prompt date anchoring', () => {
      it('injects the current date and year, with no hardcoded stale years', async () => {
        // Regression: the prompt used to hardcode "released after 2024" and
        // give a year-suffixed example, so the router appended training-era
        // years ("XYZ 2024 2025") to queries regardless of the actual date.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-23T12:00:00Z'));
        try {
          mockOpenAIClient.chat.completions.create.mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    needsWebSearch: false,
                    searchQuery: '',
                    searchRecency: 'none',
                    searchComprehensive: false,
                    additionalSearchQueries: [],
                  }),
                },
              },
            ],
          });

          await service.determineTool({
            messages: [],
            currentMessage: 'hello',
          });

          const systemPrompt =
            mockOpenAIClient.chat.completions.create.mock.calls[0][0]
              .messages[0].content;
          expect(systemPrompt).toContain("Today's date is 2026-07-23");
          expect(systemPrompt).toContain('current year is 2026');
          expect(systemPrompt).toContain('released after 2025');
          expect(systemPrompt).not.toContain('released after 2024');
          expect(systemPrompt).toContain('India protests 2026');
          expect(systemPrompt).toContain('do NOT append a year by default');
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe('classifyDocumentTrim', () => {
      function mockClassification(payload: unknown) {
        mockOpenAIClient.chat.completions.create.mockResolvedValue({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        });
      }

      const baseRequest = {
        messages: [
          {
            role: 'user',
            content: 'réduis ce document à 6000 mots',
            messageType: MessageType.TEXT,
          } as Message,
        ],
        currentMessage:
          'réduis ce document à 6000 mots\n\n[Files attached to the current message: manuscript.docx]',
        documentFilename: 'manuscript.docx',
      };

      it('maps a word-count classification to an absolute target', async () => {
        mockClassification({
          isLengthReductionRequest: true,
          targetIsAttachedDocument: true,
          targetValue: 6000,
          targetUnit: 'words',
        });

        const target = await service.classifyDocumentTrim(baseRequest);

        expect(target).toEqual({
          kind: 'absolute',
          unit: 'words',
          target: 6000,
          approx: false,
        });
        // The classifier receives the enriched currentMessage as the last
        // message and the filename in the system prompt — meaning-based,
        // works in any language.
        const call = mockOpenAIClient.chat.completions.create.mock.calls[0][0];
        expect(call.messages[0].content).toContain('manuscript.docx');
        expect(call.messages[0].content).toContain('ANY language');
        expect(call.messages[call.messages.length - 1].content).toBe(
          baseRequest.currentMessage,
        );
        expect(call.response_format.json_schema.name).toBe(
          'document_trim_classification',
        );
      });

      it('maps pages to approximate words', async () => {
        mockClassification({
          isLengthReductionRequest: true,
          targetIsAttachedDocument: true,
          targetValue: 5,
          targetUnit: 'pages',
        });
        expect(await service.classifyDocumentTrim(baseRequest)).toEqual({
          kind: 'absolute',
          unit: 'words',
          target: 2500,
          approx: true,
        });
      });

      it('maps percent_to_keep to a ratio target', async () => {
        mockClassification({
          isLengthReductionRequest: true,
          targetIsAttachedDocument: true,
          targetValue: 50,
          targetUnit: 'percent_to_keep',
        });
        expect(await service.classifyDocumentTrim(baseRequest)).toEqual({
          kind: 'ratio',
          keep: 0.5,
          approx: true,
        });
      });

      it.each([
        [
          'not a reduction request',
          {
            isLengthReductionRequest: false,
            targetIsAttachedDocument: false,
            targetValue: 0,
            targetUnit: 'none',
          },
        ],
        [
          'zero target',
          {
            isLengthReductionRequest: true,
            targetIsAttachedDocument: true,
            targetValue: 0,
            targetUnit: 'words',
          },
        ],
        [
          'percent >= 100',
          {
            isLengthReductionRequest: true,
            targetIsAttachedDocument: true,
            targetValue: 120,
            targetUnit: 'percent_to_keep',
          },
        ],
        [
          // A trimmable file sits earlier in the conversation, but the user
          // is shortening text they pasted into the chat — the file pipeline
          // (and its code-interpreter round-trip) must not hijack the turn.
          'a length target aimed at chat text, not the attached document',
          {
            isLengthReductionRequest: true,
            targetIsAttachedDocument: false,
            targetValue: 200,
            targetUnit: 'words',
          },
        ],
      ])('returns null for %s', async (_label, payload) => {
        mockClassification(payload);
        expect(await service.classifyDocumentTrim(baseRequest)).toBeNull();
      });

      it('returns null (degrades) when the call fails', async () => {
        mockOpenAIClient.chat.completions.create.mockRejectedValue(
          new Error('API error'),
        );
        expect(await service.classifyDocumentTrim(baseRequest)).toBeNull();
      });

      it('returns null on malformed classifier output', async () => {
        mockOpenAIClient.chat.completions.create.mockResolvedValue({
          choices: [{ message: { content: 'not json' } }],
        });
        expect(await service.classifyDocumentTrim(baseRequest)).toBeNull();
      });
    });

    describe('classifier input construction', () => {
      it('sends the enriched currentMessage as the last message, not the raw text', async () => {
        // Regression: the enricher builds `currentMessage` with file
        // excerpts and the attachment manifest, but the classifier call used
        // to map the raw conversation messages instead — so the router LLM
        // saw "trim this to 6k words" with no evidence a file existed and
        // classified document-transformation requests as pure text tasks.
        mockOpenAIClient.chat.completions.create.mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  searchRecency: 'none',
                  searchComprehensive: false,
                  additionalSearchQueries: [],
                  needsCodeExecution: true,
                  codeTask: 'Trim manuscript.docx to 6000 words',
                }),
              },
            },
          ],
        });

        const enriched =
          'please trim this to 6k words\n\n' +
          '[File excerpt: manuscript.docx]\nSome text…\n\n' +
          '[Files attached to the current message: manuscript.docx]';
        const result = await service.determineTool({
          messages: [
            {
              role: 'user',
              content: 'please trim this to 6k words',
              messageType: MessageType.TEXT,
            } as Message,
          ],
          currentMessage: enriched,
          considerCodeExecution: true,
        });

        const sentMessages =
          mockOpenAIClient.chat.completions.create.mock.calls[0][0].messages;
        expect(sentMessages[sentMessages.length - 1].content).toBe(enriched);
        expect(result.tools).toContain('code_interpreter');
        expect(result.codeTask).toBe('Trim manuscript.docx to 6000 words');
      });
    });

    describe('real-world scenarios', () => {
      it('should recognize need for real-time stock price data', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: true,
                  searchQuery: 'AAPL stock price today',
                  reasoning: 'Query requires current stock market data',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: "What's the current price of AAPL stock?",
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: "What's the current price of AAPL stock?",
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        expect(result.tools).toEqual(['web_search']);
        expect(result.searchQuery).toBeTruthy();
      });

      it('should not search for creative writing tasks', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  reasoning: 'Creative writing task, no external data needed',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: 'Write a short story about a robot',
              messageType: MessageType.TEXT,
            },
          ],
          currentMessage: 'Write a short story about a robot',
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        expect(result.tools).toEqual([]);
      });

      it('should not search for questions about uploaded files', async () => {
        const mockResponse = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsWebSearch: false,
                  searchQuery: '',
                  reasoning:
                    'Question about uploaded file, no web search needed',
                }),
              },
            },
          ],
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request = {
          messages: [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: 'Summarize this document' },
                {
                  type: 'file_url' as const,
                  url: 'https://example.com/doc.pdf',
                  originalFilename: 'doc.pdf',
                },
              ],
              messageType: MessageType.FILE,
            },
          ],
          currentMessage: 'Summarize this document',
          forceWebSearch: false,
        };

        const result = await service.determineTool(request);

        expect(result.tools).toEqual([]);
      });
    });
  });
});
