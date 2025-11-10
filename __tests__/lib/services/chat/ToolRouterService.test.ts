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
        expect(result.reasoning).toBe('Forced web search mode');
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
        expect(result.reasoning).toBe('Query asks for current events');
        expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalled();
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
        expect(result.reasoning).toBe(
          'General knowledge question about mathematics, no current data needed',
        );
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
      it('should use gpt-5-mini model for tool routing', async () => {
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
        expect(callArgs[0].model).toBe('gpt-5-mini');
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
        });
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
