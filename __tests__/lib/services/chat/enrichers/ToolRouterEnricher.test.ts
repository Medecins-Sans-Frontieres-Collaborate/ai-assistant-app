/**
 * Unit Tests for ToolRouterEnricher
 *
 * Tests the enricher that adds intelligent web search capabilities to the chat pipeline.
 */
import {
  createTestChatContext,
  createTestMessage,
} from '@/__tests__/lib/services/chat/testUtils';
import { AgentChatService } from '@/lib/services/chat/AgentChatService';
import { ToolRouterService } from '@/lib/services/chat/ToolRouterService';
import { ToolRouterEnricher } from '@/lib/services/chat/enrichers/ToolRouterEnricher';

import { Message, MessageType } from '@/types/chat';
import { SearchMode } from '@/types/searchMode';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('ToolRouter Enricher', () => {
  let enricher: ToolRouterEnricher;
  let mockToolRouterService: any;
  let mockAgentChatService: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock ToolRouterService
    mockToolRouterService = {
      determineTool: vi.fn(),
    };

    // Mock AgentChatService
    mockAgentChatService = {
      executeWebSearchTool: vi.fn(),
    };

    // Create enricher instance
    enricher = new ToolRouterEnricher(
      mockToolRouterService,
      mockAgentChatService,
    );

    // Mock the WebSearchTool that gets created internally
    // We'll spy on the execute method after it's created
    const originalWebSearchToolExecute = vi.fn();
    (enricher as any).webSearchTool = {
      execute: originalWebSearchToolExecute,
    };
  });

  describe('shouldRun', () => {
    it('should return true for INTELLIGENT search mode', () => {
      const context = createTestChatContext({
        searchMode: SearchMode.INTELLIGENT,
      });

      expect(enricher.shouldRun(context)).toBe(true);
    });

    it('should return true for ALWAYS search mode', () => {
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
      });

      expect(enricher.shouldRun(context)).toBe(true);
    });

    it('should return false for OFF search mode', () => {
      const context = createTestChatContext({
        searchMode: SearchMode.OFF,
      });

      expect(enricher.shouldRun(context)).toBe(false);
    });

    it('should return false for AGENT search mode', () => {
      const context = createTestChatContext({
        searchMode: SearchMode.AGENT,
      });

      expect(enricher.shouldRun(context)).toBe(false);
    });

    it('should return false when searchMode is undefined', () => {
      const context = createTestChatContext({
        searchMode: undefined,
      });

      expect(enricher.shouldRun(context)).toBe(false);
    });

    describe('with organization agents (botId)', () => {
      it('should return true for org agent with allowWebSearch and INTELLIGENT mode', () => {
        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          botId: 'msf_communications', // This agent has allowWebSearch: true
        });

        expect(enricher.shouldRun(context)).toBe(true);
      });

      it('should return true for org agent with allowWebSearch and ALWAYS mode', () => {
        const context = createTestChatContext({
          searchMode: SearchMode.ALWAYS,
          botId: 'msf_communications',
        });

        expect(enricher.shouldRun(context)).toBe(true);
      });

      it('should return false for org agent with allowWebSearch but OFF mode', () => {
        const context = createTestChatContext({
          searchMode: SearchMode.OFF,
          botId: 'msf_communications',
        });

        expect(enricher.shouldRun(context)).toBe(false);
      });

      it('should return false for org agent without allowWebSearch', () => {
        // Non-existent agent ID will return undefined from getOrganizationAgentById
        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          botId: 'agent_without_web_search',
        });

        expect(enricher.shouldRun(context)).toBe(false);
      });
    });
  });

  describe('executeStage', () => {
    describe('when no tools are needed', () => {
      it('should return context unchanged when tool router returns empty array', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: [],
          reasoning: 'No tools needed',
        });

        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'What is 2+2?' })],
        });

        const result = await enricher.execute(context);

        expect(result).toEqual(context);
        expect((enricher as any).webSearchTool.execute).not.toHaveBeenCalled();
      });

      it('should use enrichedMessages if available', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: [],
          reasoning: 'No tools needed',
        });

        const enrichedMessages = [
          createTestMessage({ content: 'Previous message' }),
          createTestMessage({ content: 'Current message' }),
        ];

        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'Original message' })],
          enrichedMessages,
        });

        await enricher.execute(context);

        // Verify it used enrichedMessages
        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: enrichedMessages,
          }),
        );
      });
    });

    describe('when web search is needed', () => {
      it('should execute web search and add results to enrichedMessages', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: ['web_search'],
          searchQuery: 'current weather in Seattle',
          reasoning: 'User asking for current weather',
        });

        (enricher as any).webSearchTool.execute.mockResolvedValue({
          text: 'The weather in Seattle is 65°F and partly cloudy.',
          citations: [
            { title: 'Weather.com', url: 'https://weather.com/seattle' },
          ],
        });

        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [
            createTestMessage({ content: "What's the weather in Seattle?" }),
          ],
          model: { agentId: 'test-agent-id' },
        });

        const result = await enricher.execute(context);

        // Verify web search was executed
        expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith({
          searchQuery: 'current weather in Seattle',
          model: context.model,
          user: context.user,
        });

        // Verify enrichedMessages were created
        expect(result.enrichedMessages).toBeDefined();
        expect(result.enrichedMessages?.length).toBe(1);

        // Check that search results were merged into the user message
        const enrichedMessage = result.enrichedMessages?.[0];
        expect(enrichedMessage?.role).toBe('user');
        expect(enrichedMessage?.content).toContain(
          'The weather in Seattle is 65°F and partly cloudy.',
        );
        expect(enrichedMessage?.content).toContain('[1] Weather.com');

        // Verify original message content is also present
        expect(enrichedMessage?.content).toContain(
          "What's the weather in Seattle?",
        );
      });

      it('should store citations in metadata with number property', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: ['web_search'],
          searchQuery: 'latest AI news',
          reasoning: 'Current events query',
        });

        const citations = [
          { title: 'AI News 1', url: 'https://example.com/1' },
          { title: 'AI News 2', url: 'https://example.com/2' },
        ];

        (enricher as any).webSearchTool.execute.mockResolvedValue({
          text: 'AI news content',
          citations,
        });

        const context = createTestChatContext({
          searchMode: SearchMode.ALWAYS,
          messages: [createTestMessage({ content: 'Latest AI news?' })],
          model: { agentId: 'test-agent' },
        });

        const result = await enricher.execute(context);

        // Citations should be merged with number property for proper ordering
        expect(result.processedContent?.metadata?.citations).toEqual([
          { title: 'AI News 1', url: 'https://example.com/1', number: 1 },
          { title: 'AI News 2', url: 'https://example.com/2', number: 2 },
        ]);
      });

      it('should merge web search citations with existing RAG citations', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: ['web_search'],
          searchQuery: 'MSF operations',
          reasoning: 'Need current information',
        });

        const webSearchCitations = [
          { title: 'Web Source 1', url: 'https://web1.com' },
          { title: 'Web Source 2', url: 'https://web2.com' },
        ];

        (enricher as any).webSearchTool.execute.mockResolvedValue({
          text: 'Web search results',
          citations: webSearchCitations,
        });

        // Simulate existing RAG citations (from RAGEnricher)
        const existingRagCitations = [
          {
            title: 'RAG Source 1',
            url: 'https://rag1.com',
            date: '2024-01-15',
            number: 1,
          },
          {
            title: 'RAG Source 2',
            url: 'https://rag2.com',
            date: '2024-01-10',
            number: 2,
          },
        ];

        const context = createTestChatContext({
          searchMode: SearchMode.ALWAYS,
          messages: [createTestMessage({ content: 'Tell me about MSF' })],
          model: { agentId: 'test-agent' },
          processedContent: {
            metadata: {
              citations: existingRagCitations,
            },
          },
        });

        const result = await enricher.execute(context);

        // Should have 4 citations total: 2 RAG + 2 web search
        expect(result.processedContent?.metadata?.citations).toHaveLength(4);

        // RAG citations should be preserved as-is
        expect(result.processedContent?.metadata?.citations?.[0]).toEqual(
          existingRagCitations[0],
        );
        expect(result.processedContent?.metadata?.citations?.[1]).toEqual(
          existingRagCitations[1],
        );

        // Web search citations should have numbers continuing from RAG
        expect(result.processedContent?.metadata?.citations?.[2]).toEqual({
          title: 'Web Source 1',
          url: 'https://web1.com',
          number: 3, // Continues from RAG citation #2
        });
        expect(result.processedContent?.metadata?.citations?.[3]).toEqual({
          title: 'Web Source 2',
          url: 'https://web2.com',
          number: 4,
        });
      });

      it('should force web search in ALWAYS mode', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: ['web_search'],
          searchQuery: 'forced search',
          reasoning: 'Forced mode',
        });

        (enricher as any).webSearchTool.execute.mockResolvedValue({
          text: 'Results',
          citations: [],
        });

        const context = createTestChatContext({
          searchMode: SearchMode.ALWAYS,
          messages: [createTestMessage({ content: 'Any query' })],
          model: { agentId: 'test-agent' },
        });

        await enricher.execute(context);

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({
            forceWebSearch: true,
          }),
        );
      });
    });

    describe('error handling', () => {
      it('should continue without search if web search fails', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: ['web_search'],
          searchQuery: 'test',
          reasoning: 'Test',
        });

        (enricher as any).webSearchTool.execute.mockRejectedValue(
          new Error('Search service unavailable'),
        );

        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'Test query' })],
          model: { agentId: 'test-agent' },
        });

        const result = await enricher.execute(context);

        // Should return context unchanged (without enrichedMessages)
        expect(result).toEqual(context);
        expect(result.enrichedMessages).toBeUndefined();
      });

      it('should handle tool router errors gracefully', async () => {
        mockToolRouterService.determineTool.mockRejectedValue(
          new Error('Tool router failed'),
        );

        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'Test' })],
        });

        // Should catch the error and add it to context.errors
        const result = await enricher.execute(context);

        expect(result.errors).toBeDefined();
        expect(result.errors).toHaveLength(1);
        expect(result.errors![0].message).toContain('Tool router failed');
      });
    });

    describe('processed content integration', () => {
      it('should include file summaries in tool router request', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: [],
          reasoning: 'No search needed',
        });

        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'Analyze this' })],
          processedContent: {
            fileSummaries: [
              { filename: 'doc1.pdf', summary: 'Summary of document 1' },
              { filename: 'doc2.pdf', summary: 'Summary of document 2' },
            ],
          },
        });

        await enricher.execute(context);

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({
            currentMessage: expect.stringContaining('[File: doc1.pdf]'),
          }),
        );

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({
            currentMessage: expect.stringContaining('Summary of document 1'),
          }),
        );
      });

      it('should include transcripts in tool router request', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: [],
          reasoning: 'No search needed',
        });

        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'What did they say?' })],
          processedContent: {
            transcripts: [
              {
                filename: 'audio.mp3',
                transcript: 'This is the audio transcript',
              },
            ],
          },
        });

        await enricher.execute(context);

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({
            currentMessage: expect.stringContaining('[Audio/Video: audio.mp3]'),
          }),
        );

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({
            currentMessage: expect.stringContaining(
              'This is the audio transcript',
            ),
          }),
        );
      });
    });
  });
});
