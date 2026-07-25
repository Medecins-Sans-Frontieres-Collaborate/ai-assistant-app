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
import { readCitedSources } from '@/lib/services/chat/tools/citedSourceReader';

import { Message, MessageType } from '@/types/chat';
import { InterpreterMode } from '@/types/interpreterMode';
import { SearchMode } from '@/types/searchMode';

import { env } from '@/config/environment';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/chat/tools/citedSourceReader', () => ({
  readCitedSources: vi.fn(),
}));

describe('ToolRouter Enricher', () => {
  let enricher: ToolRouterEnricher;
  let mockToolRouterService: any;
  let mockAgentChatService: any;

  const priorProvider = env.WEB_SEARCH_PROVIDER;
  afterAll(() => {
    (env as any).WEB_SEARCH_PROVIDER = priorProvider;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Most search expectations here encode the Bing-agent path (agent model
    // requirement, model-labeled records); google-news has its own describe.
    (env as any).WEB_SEARCH_PROVIDER = 'bing-agent';

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

    describe('with prompt agents (botId + context.promptAgent)', () => {
      // Prompt agents arrive via botId but ride the standard execution
      // path: web search must behave exactly as for a plain model, not be
      // silently disabled by the static org-agent gate (which can never
      // resolve a `prompt-<hex>` id).
      const promptAgentRecord = {
        version: 1 as const,
        id: 'prompt-abc123def456',
        name: 'Persona',
        description: '',
        systemPrompt: 'You are a persona.',
        modelId: 'gpt-5.2',
        createdBy: 'admin@msf.org',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedBy: 'admin@msf.org',
        updatedAt: '2026-07-18T00:00:00.000Z',
      };

      function makePromptAgentContext(searchMode: SearchMode | undefined) {
        const context = createTestChatContext({
          searchMode,
          botId: promptAgentRecord.id,
        });
        context.promptAgent = promptAgentRecord;
        return context;
      }

      it('should return true for ALWAYS mode', () => {
        expect(
          enricher.shouldRun(makePromptAgentContext(SearchMode.ALWAYS)),
        ).toBe(true);
      });

      it('should return true for INTELLIGENT mode', () => {
        expect(
          enricher.shouldRun(makePromptAgentContext(SearchMode.INTELLIGENT)),
        ).toBe(true);
      });

      it('should return false for OFF mode', () => {
        expect(enricher.shouldRun(makePromptAgentContext(SearchMode.OFF))).toBe(
          false,
        );
      });

      it('should return false when searchMode is undefined', () => {
        expect(enricher.shouldRun(makePromptAgentContext(undefined))).toBe(
          false,
        );
      });

      it('an unresolved prompt- botId WITHOUT a persona keeps the org-agent gate (false)', () => {
        // No context.promptAgent (record deleted/unknown): the botId branch
        // applies and the unresolvable id disables search as before.
        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          botId: 'prompt-abc123def456',
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

    describe('precomputedSearchResults (summarize from headlines)', () => {
      const entries = [
        {
          title: 'Fusion record broken',
          url: 'https://a.example/1',
          date: '2026-07-23',
          sourceName: 'a.example',
          snippet: 'A tokamak sustained plasma for a record time.',
        },
        {
          title: 'Funding round for fusion startup',
          url: 'https://b.example/2',
          date: '2026-07-22',
        },
      ];

      it('merges echoed headlines as THE search result — no router call, no search', async () => {
        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'Latest fusion news?' })],
          precomputedSearchResults: {
            queries: ['fusion news'],
            entries,
          },
        });

        const result = await enricher.execute(context);

        expect(mockToolRouterService.determineTool).not.toHaveBeenCalled();
        expect((enricher as any).webSearchTool.execute).not.toHaveBeenCalled();

        const lastMsg =
          result.enrichedMessages![result.enrichedMessages!.length - 1];
        expect(lastMsg.content).toContain('Web Search results');
        expect(lastMsg.content).toContain('Fusion record broken');

        const citations = result.processedContent?.metadata?.citations;
        expect(citations).toHaveLength(2);
        expect(citations![0]).toMatchObject({
          number: 1,
          url: 'https://a.example/1',
        });
        expect(citations![1]).toMatchObject({
          number: 2,
          url: 'https://b.example/2',
        });
      });

      it('shifts only line-start citation markers when RAG citations occupy the low numbers', async () => {
        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'budget question' })],
          processedContent: {
            metadata: {
              citations: [
                {
                  number: 1,
                  title: 'RAG doc',
                  url: 'https://rag.example',
                  date: '',
                },
              ],
            },
          },
          precomputedSearchResults: {
            queries: ['budget'],
            entries: [
              {
                title: 'Report cites [3] agencies',
                url: 'https://a.example/1',
                date: '2026-07-23',
                snippet: 'Audit found [2] discrepancies.',
              },
            ],
          },
        });

        const result = await enricher.execute(context);
        const merged = String(
          result.enrichedMessages![result.enrichedMessages!.length - 1].content,
        );

        // The line-start digest marker shifts past the RAG citation…
        expect(merged).toContain('[2] Report cites [3] agencies');
        // …while bracketed numbers INSIDE title/snippet stay untouched.
        expect(merged).toContain('Audit found [2] discrepancies.');
        expect(result.processedContent?.metadata?.citations).toHaveLength(2);
      });

      it('does nothing with echoed headlines when search is not requested', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({ tools: [] });
        const context = createTestChatContext({
          searchMode: SearchMode.OFF,
          interpreterMode: InterpreterMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'Hello' })],
          precomputedSearchResults: {
            queries: ['fusion news'],
            entries,
          },
        });

        const result = await enricher.execute(context);

        expect((enricher as any).webSearchTool.execute).not.toHaveBeenCalled();
        expect(result.processedContent?.metadata?.citations ?? []).toHaveLength(
          0,
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
        // This test exercises the DEPLOYMENT default (bing-agent env);
        // the store-level default provider is 'combined', so pin 'auto'.
        (context as any).webSearchOptions = {
          resultCount: 8,
          freshness: 'auto',
          provider: 'auto',
        };

        const result = await enricher.execute(context);

        // Verify web search was executed
        expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith({
          searchQuery: 'current weather in Seattle',
          searchQueries: ['current weather in Seattle'],
          model: context.model,
          user: context.user,
          resultCount: 8,
          freshness: 'any',
          provider: 'bing-agent',
          deep: false,
          onInterimResults: undefined,
          onActivity: expect.any(Function),
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

      it('skips the router LLM and runs search directly in ALWAYS mode', async () => {
        // The router service should NOT be called — we already know the
        // decision when the user picked ALWAYS, so we save the round-trip.
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

        expect(mockToolRouterService.determineTool).not.toHaveBeenCalled();
        expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
          expect.objectContaining({ searchQuery: 'Any query' }),
        );
      });
    });

    describe('error handling', () => {
      it('should degrade with a notice when web search fails', async () => {
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

        // The turn still proceeds (no errors), but the model is told the
        // search failed via a notice merged into the last message.
        expect(result.errors ?? []).toHaveLength(0);
        expect(result.enrichedMessages).toBeDefined();
        const lastMessage =
          result.enrichedMessages![result.enrichedMessages!.length - 1];
        const lastText =
          typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);
        expect(lastText).toContain('web search was attempted');
        expect(lastText).toContain('Test query');
      });

      it('should say timed out when web search times out', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: ['web_search'],
          searchQuery: 'test',
          reasoning: 'Test',
        });

        const timeoutError = Object.assign(new Error('Web search timed out'), {
          isSearchTimeout: true,
        });
        (enricher as any).webSearchTool.execute.mockRejectedValue(timeoutError);

        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'Test query' })],
          model: { agentId: 'test-agent' },
        });

        const result = await enricher.execute(context);

        expect(result.enrichedMessages).toBeDefined();
        const lastMessage =
          result.enrichedMessages![result.enrichedMessages!.length - 1];
        const lastText =
          typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);
        expect(lastText).toContain('timed out');
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
            currentMessage: expect.stringContaining(
              '[Document summary: doc1.pdf]',
            ),
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

    describe('user-provided content signal (search dilution guard)', () => {
      beforeEach(() => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: [],
          reasoning: 'No search needed',
        });
      });

      it('flags turns with uploaded files', async () => {
        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'Review this document' })],
          hasFiles: true,
        });

        await enricher.execute(context);

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({ hasUserProvidedContent: true }),
        );
      });

      it('flags turns with processed file content', async () => {
        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: 'Summarize' })],
          processedContent: {
            fileSummaries: [{ filename: 'doc.pdf', summary: 'A summary' }],
          },
        });

        await enricher.execute(context);

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({ hasUserProvidedContent: true }),
        );
      });

      it('flags turns whose prompt is a large pasted text block', async () => {
        const pastedBlock = `Please clean up this text:\n\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)}`;
        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [createTestMessage({ content: pastedBlock })],
        });

        await enricher.execute(context);

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({ hasUserProvidedContent: true }),
        );
      });

      it('does not flag a short typed question', async () => {
        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          messages: [
            createTestMessage({ content: 'What happened in the news today?' }),
          ],
        });

        await enricher.execute(context);

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({ hasUserProvidedContent: false }),
        );
      });

      it('ALWAYS mode still forces search without consulting the classifier, files or not', async () => {
        (enricher as any).webSearchTool.execute.mockResolvedValue({
          text: 'Result.',
          citations: [],
        });
        const context = createTestChatContext({
          searchMode: SearchMode.ALWAYS,
          messages: [createTestMessage({ content: 'Check this file' })],
          hasFiles: true,
        });

        await enricher.execute(context);

        expect(mockToolRouterService.determineTool).not.toHaveBeenCalled();
        expect((enricher as any).webSearchTool.execute).toHaveBeenCalled();
      });
    });
  });

  describe('web search tuning (options + dynamic router signals)', () => {
    beforeEach(() => {
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Result.',
        citations: [{ title: 'A', url: 'https://a.example' }],
      });
    });

    it('uses defaults when no options are set (8 sources, no freshness)', async () => {
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        model: { agentId: 'agent-1' },
      });

      await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({ resultCount: 8, freshness: 'any' }),
      );
    });

    it('applies the user-configured options', async () => {
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        model: { agentId: 'agent-1' },
      });
      context.webSearchOptions = { resultCount: 4, freshness: 'month' };

      await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({ resultCount: 4, freshness: 'month' }),
      );
    });

    it("with freshness 'auto' the router's recency applies", async () => {
      mockToolRouterService.determineTool.mockResolvedValue({
        tools: ['web_search'],
        searchQuery: 'latest news',
        searchRecency: 'day',
      });
      const context = createTestChatContext({
        searchMode: SearchMode.INTELLIGENT,
        model: { agentId: 'agent-1' },
      });
      context.webSearchOptions = { resultCount: 8, freshness: 'auto' };

      await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({ freshness: 'day' }),
      );
    });

    it('an explicit freshness setting overrides the router', async () => {
      mockToolRouterService.determineTool.mockResolvedValue({
        tools: ['web_search'],
        searchQuery: 'latest news',
        searchRecency: 'day',
      });
      const context = createTestChatContext({
        searchMode: SearchMode.INTELLIGENT,
        model: { agentId: 'agent-1' },
      });
      context.webSearchOptions = { resultCount: 8, freshness: 'month' };

      await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({ freshness: 'month' }),
      );
    });

    it('research-style questions widen the source cap', async () => {
      mockToolRouterService.determineTool.mockResolvedValue({
        tools: ['web_search'],
        searchQuery: 'compare all major frameworks',
        searchComprehensive: true,
      });
      const context = createTestChatContext({
        searchMode: SearchMode.INTELLIGENT,
        model: { agentId: 'agent-1' },
      });
      context.webSearchOptions = { resultCount: 6, freshness: 'auto' };

      await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({ resultCount: 12 }),
      );
    });
  });

  describe('web search empty results + live progress (UX fixes)', () => {
    it('treats 0 citations as no-results: confident-answer notice, no results block', async () => {
      // Also the shape WebSearchTool returns when it swallowed an error.
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: '*Note: Web search encountered an issue*',
        citations: [],
      });
      const emitMarker = vi.fn().mockResolvedValue(undefined);
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        messages: [createTestMessage({ content: 'obscure question' })],
        model: { agentId: 'agent-1', id: 'gpt-5.2' },
        emitMarker,
      });

      const result = await enricher.execute(context);

      const lastMessage =
        result.enrichedMessages![result.enrichedMessages!.length - 1];
      // No fake results block, no apology spiral — confident knowledge answer
      expect(lastMessage.content).not.toContain('Web Search results:');
      expect(lastMessage.content).toContain('found no useful sources');
      expect(lastMessage.content).toContain('question confidently');
      // No citations merged
      expect(result.processedContent?.metadata?.citations).toBeUndefined();

      // The record shows the empty outcome
      const record = JSON.parse(
        (emitMarker.mock.calls[0][0] as string)
          .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
          .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, ''),
      );
      expect(record.status).toBe('completed');
      expect(record.output).toBe('0 sources found');
    });

    it('shows the actual query in the loader and forwards inner progress', async () => {
      const emitActivity = vi.fn().mockResolvedValue(undefined);
      (enricher as any).webSearchTool.execute.mockImplementation(
        async (params: any) => {
          // Inner stream phases forwarded by AgentChatService
          params.onActivity?.('chat.activity.searchingWeb'); // generic — skipped
          params.onActivity?.('chat.activity.usingNamedTool', {
            tool: 'bing_grounding',
          });
          return {
            text: 'Result.',
            citations: [{ title: 'A', url: 'https://a.example' }],
          };
        },
      );
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        messages: [createTestMessage({ content: 'India protests 2026' })],
        model: { agentId: 'agent-1', id: 'gpt-5.2' },
      });
      context.emitActivity = emitActivity;

      await enricher.execute(context);

      // Query-bearing loader first
      expect(emitActivity).toHaveBeenCalledWith(
        'chat.activity.searchingWebFor',
        { query: 'India protests 2026' },
      );
      // Inner phase forwarded; generic searchingWeb NOT re-emitted
      expect(emitActivity).toHaveBeenCalledWith(
        'chat.activity.usingNamedTool',
        { tool: 'bing_grounding' },
      );
      expect(emitActivity).not.toHaveBeenCalledWith(
        'chat.activity.searchingWeb',
      );
    });
  });

  describe('web search citation normalization (phantom-pair fix)', () => {
    it('drops URL-less entries and remaps text refs to the final numbering', async () => {
      // The exact broken shape: marker/annotation pairs where odd numbers
      // are URL-less phantoms cited in the text and even numbers carry the
      // real sources.
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Delhi protests[1] over exams[3]; internet cut[5].',
        citations: [
          { number: 1, title: 'source', url: '', date: '' },
          { number: 2, title: 'Wikipedia', url: 'https://w.example', date: '' },
          { number: 3, title: 'source', url: '', date: '' },
          { number: 4, title: 'Amnesty', url: 'https://a.example', date: '' },
          { number: 5, title: 'source', url: '', date: '' },
          { number: 6, title: 'CJP', url: 'https://c.example', date: '' },
        ],
      });
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        messages: [createTestMessage({ content: 'India protests?' })],
        model: { agentId: 'agent-1', id: 'gpt-5.4' },
      });

      const result = await enricher.execute(context);

      // Only the 3 real sources survive, renumbered 1..3
      const citations = result.processedContent?.metadata?.citations;
      expect(citations).toHaveLength(3);
      expect(citations.map((c: any) => [c.number, c.url])).toEqual([
        [1, 'https://w.example'],
        [2, 'https://a.example'],
        [3, 'https://c.example'],
      ]);

      // Text refs remapped to the surviving numbers — no dangling [5]s
      const merged = String(
        result.enrichedMessages![result.enrichedMessages!.length - 1].content,
      );
      expect(merged).not.toContain('[5]');
      expect(merged).toContain('internet cut[3]');
      // Available-sources list matches
      expect(merged).toContain('[1] Wikipedia');
      expect(merged).toContain('[3] CJP');
      expect(merged).not.toContain('source\n');
    });

    it('dedupes same-URL citations onto one number', async () => {
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Fact[1] and again[2].',
        citations: [
          { number: 1, title: 'A', url: 'https://a.example', date: '' },
          { number: 2, title: 'A (dup)', url: 'https://a.example', date: '' },
        ],
      });
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        model: { agentId: 'agent-1' },
      });

      const result = await enricher.execute(context);

      expect(result.processedContent?.metadata?.citations).toHaveLength(1);
      const merged = String(
        result.enrichedMessages![result.enrichedMessages!.length - 1].content,
      );
      expect(merged).toContain('Fact[1] and again[1].');
    });

    it('treats an all-phantom citation list as no results', async () => {
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Something[1].',
        citations: [{ number: 1, title: 'source', url: '', date: '' }],
      });
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        model: { agentId: 'agent-1' },
      });

      const result = await enricher.execute(context);

      const merged = String(
        result.enrichedMessages![result.enrichedMessages!.length - 1].content,
      );
      expect(merged).toContain('found no useful sources');
      expect(result.processedContent?.metadata?.citations).toBeUndefined();
    });
  });

  describe('google-news provider', () => {
    beforeEach(() => {
      (env as any).WEB_SEARCH_PROVIDER = 'google-news';
    });

    it('runs without an agent-backed model and labels the record Google News', async () => {
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Digest.',
        citations: [{ number: 1, title: 'A', url: 'https://a.example' }],
      });
      const emitMarker = vi.fn().mockResolvedValue(undefined);
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        messages: [createTestMessage({ content: 'india protests' })],
        // No agentId anywhere — the Bing path would skip; google must not.
        model: { id: 'Mistral-Large-3' },
        emitMarker,
      });
      // Exercises the DEPLOYMENT default (google-news env); the store-level
      // default provider is 'combined', so pin 'auto'.
      (context as any).webSearchOptions = {
        resultCount: 8,
        freshness: 'auto',
        provider: 'auto',
      };

      const result = await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({ searchQuery: 'india protests' }),
      );
      expect(result.processedContent?.metadata?.citations).toHaveLength(1);

      const record = JSON.parse(
        (emitMarker.mock.calls[0][0] as string)
          .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
          .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, ''),
      );
      expect(record.server_label).toBe('Web Search (Google News)');
    });
  });

  describe('user-selected search provider', () => {
    it('overrides the deployment default and labels the record accordingly', async () => {
      // env default is bing-agent (beforeEach), but the user picked
      // google-news in Settings → the feed path runs, no agent model needed.
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Digest.',
        citations: [{ number: 1, title: 'A', url: 'https://a.example' }],
      });
      const emitMarker = vi.fn().mockResolvedValue(undefined);
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        messages: [createTestMessage({ content: 'india protests' })],
        model: { id: 'Mistral-Large-3' },
        emitMarker,
      });
      (context as any).webSearchOptions = {
        resultCount: 8,
        freshness: 'auto',
        provider: 'google-news',
      };

      await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'google-news' }),
      );
      const record = JSON.parse(
        (emitMarker.mock.calls[0][0] as string)
          .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
          .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, ''),
      );
      expect(record.server_label).toBe('Web Search (Google News)');
    });

    it('bing-responses runs without an agent model and labels the record with the deployment', async () => {
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Grounded digest.[1]',
        citations: [{ number: 1, title: 'A', url: 'https://a.example' }],
      });
      const emitMarker = vi.fn().mockResolvedValue(undefined);
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        messages: [createTestMessage({ content: 'india protests' })],
        // No agentId anywhere — the Responses path needs no Foundry agent.
        model: { id: 'Mistral-Large-3' },
        emitMarker,
      });
      (context as any).webSearchOptions = {
        resultCount: 8,
        freshness: 'auto',
        provider: 'bing-responses',
      };

      const result = await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'bing-responses',
          searchQuery: 'india protests',
        }),
      );
      expect(result.processedContent?.metadata?.citations).toHaveLength(1);

      const record = JSON.parse(
        (emitMarker.mock.calls[0][0] as string)
          .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
          .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, ''),
      );
      expect(record.server_label).toBe(
        `Web Search (Bing web_search (${env.WEB_SEARCH_RESPONSES_MODEL}))`,
      );
    });

    it("'auto' keeps the deployment default (bing-agent path here)", async () => {
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Results.',
        citations: [{ number: 1, title: 'A', url: 'https://a.example' }],
      });
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        messages: [createTestMessage({ content: 'india protests' })],
        model: { agentId: 'agent-1', id: 'gpt-5.2' },
      });
      (context as any).webSearchOptions = {
        resultCount: 8,
        freshness: 'auto',
        provider: 'auto',
      };

      await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'bing-agent' }),
      );
    });
  });

  describe('multi-query fan-out', () => {
    it('passes the query list through, shows the multi-topic loader, and records every query', async () => {
      (env as any).WEB_SEARCH_PROVIDER = 'news';
      mockToolRouterService.determineTool.mockResolvedValue({
        tools: ['web_search'],
        searchQuery: 'france strikes 2026',
        searchQueries: ['france strikes 2026', 'germany rail dispute 2026'],
      });
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Merged digest.',
        citations: [{ number: 1, title: 'A', url: 'https://a.example' }],
      });
      const emitMarker = vi.fn().mockResolvedValue(undefined);
      const emitActivity = vi.fn().mockResolvedValue(undefined);
      const context = createTestChatContext({
        searchMode: SearchMode.INTELLIGENT,
        messages: [
          createTestMessage({ content: 'compare france and germany disputes' }),
        ],
        model: { id: 'Mistral-Large-3' },
        emitMarker,
      });
      (context as any).emitActivity = emitActivity;

      await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          searchQuery: 'france strikes 2026',
          searchQueries: ['france strikes 2026', 'germany rail dispute 2026'],
        }),
      );
      expect(emitActivity).toHaveBeenCalledWith(
        'chat.activity.searchingWebForMultiple',
        expect.objectContaining({ count: '2' }),
      );
      const record = JSON.parse(
        (emitMarker.mock.calls[0][0] as string)
          .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
          .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, ''),
      );
      expect(JSON.parse(record.arguments).query).toBe(
        'france strikes 2026 | germany rail dispute 2026',
      );
    });
  });

  describe('cited-source follow-up', () => {
    const historyWithCitations = () => [
      createTestMessage({ content: 'protests in india?' }),
      createTestMessage({
        role: 'assistant',
        content: 'Earlier answer [1][2]',
        citations: [
          {
            number: 1,
            title: 'Story A',
            url: 'https://pub-a.example/a',
            date: '',
            sourceName: 'Pub A',
          },
          {
            number: 2,
            title: 'Story B',
            url: 'https://pub-b.example/b',
            date: '',
          },
        ],
      } as Partial<Message>),
      createTestMessage({ content: 'what does the Pub A article say?' }),
    ];

    beforeEach(() => {
      vi.mocked(readCitedSources).mockReset();
    });

    it('offers prior citations to the router', async () => {
      mockToolRouterService.determineTool.mockResolvedValue({ tools: [] });
      const context = createTestChatContext({
        searchMode: SearchMode.INTELLIGENT,
        messages: historyWithCitations(),
      });

      await enricher.execute(context);

      expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
        expect.objectContaining({ hasPriorSearchCitations: true }),
      );
    });

    it('fetches cited articles instead of searching when the follow-up succeeds', async () => {
      mockToolRouterService.determineTool.mockResolvedValue({
        tools: ['web_search'],
        searchQuery: 'india protests',
        searchFollowUp: true,
      });
      vi.mocked(readCitedSources).mockResolvedValue({
        text: 'Full article content from the sources previously cited…\n\n[1] Story A\nDeep article body.',
        citations: [
          {
            number: 1,
            title: 'Story A',
            url: 'https://pub-a.example/a',
            date: '',
            sourceName: 'Pub A',
          },
        ],
        fetchedCount: 1,
        attemptedCount: 2,
      });
      const emitMarker = vi.fn().mockResolvedValue(undefined);
      const context = createTestChatContext({
        searchMode: SearchMode.INTELLIGENT,
        messages: historyWithCitations(),
        emitMarker,
      });

      const result = await enricher.execute(context);

      // Same sources, no fresh search.
      expect((enricher as any).webSearchTool.execute).not.toHaveBeenCalled();
      const merged = result.enrichedMessages?.at(-1)?.content as string;
      expect(merged).toContain('Deep article body.');
      expect(result.processedContent?.metadata?.citations).toHaveLength(1);

      const record = JSON.parse(
        (emitMarker.mock.calls[0][0] as string)
          .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
          .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, ''),
      );
      expect(record.server_label).toBe('Web Search (Cited sources)');
      expect(record.output).toBe('1 of 2 articles read');
    });

    it('falls back to a fresh search when no cited article is readable', async () => {
      mockToolRouterService.determineTool.mockResolvedValue({
        tools: ['web_search'],
        searchQuery: 'india protests',
        searchFollowUp: true,
      });
      vi.mocked(readCitedSources).mockResolvedValue({
        text: '',
        citations: [],
        fetchedCount: 0,
        attemptedCount: 2,
      });
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Fresh results.',
        citations: [{ number: 1, title: 'C', url: 'https://c.example' }],
      });
      const context = createTestChatContext({
        searchMode: SearchMode.INTELLIGENT,
        messages: historyWithCitations(),
        model: { agentId: 'agent-1', id: 'gpt-5.2' },
      });

      const result = await enricher.execute(context);

      expect((enricher as any).webSearchTool.execute).toHaveBeenCalled();
      expect(result.processedContent?.metadata?.citations).toHaveLength(1);
    });

    it('runs the follow-up even when the router wants no fresh search', async () => {
      mockToolRouterService.determineTool.mockResolvedValue({
        tools: [],
        searchFollowUp: true,
      });
      vi.mocked(readCitedSources).mockResolvedValue({
        text: '[1] Story A\nBody.',
        citations: [
          {
            number: 1,
            title: 'Story A',
            url: 'https://pub-a.example/a',
            date: '',
          },
        ],
        fetchedCount: 1,
        attemptedCount: 1,
      });
      const context = createTestChatContext({
        searchMode: SearchMode.INTELLIGENT,
        messages: historyWithCitations(),
      });

      const result = await enricher.execute(context);

      expect(readCitedSources).toHaveBeenCalled();
      const merged = result.enrichedMessages?.at(-1)?.content as string;
      expect(merged).toContain('Body.');
    });

    it('never consults the reader when history has no citations', async () => {
      mockToolRouterService.determineTool.mockResolvedValue({ tools: [] });
      const context = createTestChatContext({
        searchMode: SearchMode.INTELLIGENT,
        messages: [createTestMessage({ content: 'hello' })],
      });

      await enricher.execute(context);

      expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
        expect.objectContaining({ hasPriorSearchCitations: false }),
      );
      expect(readCitedSources).not.toHaveBeenCalled();
    });
  });

  describe('web search tool record (parity with code interpreter)', () => {
    function extractRecord(marker: string) {
      return JSON.parse(
        marker
          .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
          .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, ''),
      );
    }

    it('emits a completed record with query, executing model, and outcome', async () => {
      (enricher as any).webSearchTool.execute.mockResolvedValue({
        text: 'Result text.',
        citations: [
          { title: 'A', url: 'https://a.example' },
          { title: 'B', url: 'https://b.example' },
        ],
      });
      const emitMarker = vi.fn().mockResolvedValue(undefined);
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        messages: [createTestMessage({ content: 'latest EU AI act status' })],
        model: { agentId: 'agent-1', id: 'gpt-5.2' },
        emitMarker,
      });
      // Model-labeled record = the bing-agent env path; pin 'auto' so the
      // store-level 'combined' default doesn't reroute it.
      (context as any).webSearchOptions = {
        resultCount: 8,
        freshness: 'auto',
        provider: 'auto',
      };

      await enricher.execute(context);

      expect(emitMarker).toHaveBeenCalledTimes(1);
      const record = extractRecord(emitMarker.mock.calls[0][0] as string);
      expect(record.name).toBe('web_search');
      expect(record.server_label).toBe('Web Search (gpt-5.2)');
      expect(JSON.parse(record.arguments).query).toBe(
        'latest EU AI act status',
      );
      expect(record.status).toBe('completed');
      expect(record.output).toBe('2 sources found');
      expect(typeof record.duration_ms).toBe('number');
    });

    it('emits a failed record when the search errors', async () => {
      (enricher as any).webSearchTool.execute.mockRejectedValue(
        new Error('bing exploded'),
      );
      const emitMarker = vi.fn().mockResolvedValue(undefined);
      const context = createTestChatContext({
        searchMode: SearchMode.ALWAYS,
        model: { agentId: 'agent-1', id: 'gpt-5.2' },
        emitMarker,
      });

      await enricher.execute(context);

      const record = extractRecord(emitMarker.mock.calls[0][0] as string);
      expect(record.name).toBe('web_search');
      expect(record.status).toBe('failed');
      expect(record.error).toBe('Web search failed');
    });
  });

  describe('code interpreter', () => {
    const interpreterResult = {
      text: 'The mean is 42.',
      codeRuns: [
        { code: 'print(df.mean())', logs: '42.0', status: 'completed' },
      ],
      generatedFiles: [
        {
          url: '/api/file/abc123.png',
          filename: 'chart.png',
          mime_type: 'image/png',
          is_image: true,
        },
      ],
      durationMs: 1234,
    };

    let mockInterpreterExecute: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockInterpreterExecute = vi.fn().mockResolvedValue(interpreterResult);
      (enricher as any).codeInterpreterTool = {
        execute: mockInterpreterExecute,
      };
    });

    describe('shouldRun', () => {
      it('runs for INTELLIGENT interpreter mode even with search OFF', () => {
        const context = createTestChatContext({
          searchMode: SearchMode.OFF,
          interpreterMode: InterpreterMode.INTELLIGENT,
        });
        expect(enricher.shouldRun(context)).toBe(true);
      });

      it('runs for ALWAYS interpreter mode', () => {
        const context = createTestChatContext({
          interpreterMode: InterpreterMode.ALWAYS,
        });
        expect(enricher.shouldRun(context)).toBe(true);
      });

      it('does not run when both modes are OFF/undefined', () => {
        const context = createTestChatContext({
          searchMode: SearchMode.OFF,
          interpreterMode: InterpreterMode.OFF,
        });
        expect(enricher.shouldRun(context)).toBe(false);
      });

      it('respects the env kill switch', () => {
        const prior = env.CODE_INTERPRETER_ENABLED;
        (env as any).CODE_INTERPRETER_ENABLED = false;
        try {
          const context = createTestChatContext({
            interpreterMode: InterpreterMode.ALWAYS,
          });
          expect(enricher.shouldRun(context)).toBe(false);
        } finally {
          (env as any).CODE_INTERPRETER_ENABLED = prior;
        }
      });

      it('is blocked for org agents without allowCodeInterpreter', () => {
        const context = createTestChatContext({
          interpreterMode: InterpreterMode.INTELLIGENT,
          // msf_communications allows web search but not code interpreter
          botId: 'msf_communications',
        });
        expect(enricher.shouldRun(context)).toBe(false);
      });
    });

    describe('forced execution (ALWAYS)', () => {
      it('skips the router, runs the interpreter, merges results, and emits a record', async () => {
        const emitMarker = vi.fn().mockResolvedValue(undefined);
        const context = createTestChatContext({
          searchMode: SearchMode.OFF,
          interpreterMode: InterpreterMode.ALWAYS,
          messages: [createTestMessage({ content: 'Analyze my numbers' })],
          emitMarker,
        });

        const result = await enricher.execute(context);

        // Forced mode: no nano-router call
        expect(mockToolRouterService.determineTool).not.toHaveBeenCalled();
        expect(mockInterpreterExecute).toHaveBeenCalledWith(
          expect.objectContaining({ task: 'Analyze my numbers' }),
        );

        // Results merged into the last user message
        const lastMessage =
          result.enrichedMessages![result.enrichedMessages!.length - 1];
        expect(lastMessage.content).toContain('Code execution results');
        expect(lastMessage.content).toContain('The mean is 42.');
        expect(lastMessage.content).toContain('chart.png');

        // TOOL_CALL_RECORD emitted with code + generated files
        expect(emitMarker).toHaveBeenCalledTimes(1);
        const marker = emitMarker.mock.calls[0][0] as string;
        expect(marker).toContain('<<<TOOL_CALL_RECORD>>>');
        const payload = JSON.parse(
          marker
            .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
            .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, ''),
        );
        expect(payload.name).toBe('code_interpreter');
        expect(payload.status).toBe('completed');
        expect(JSON.parse(payload.arguments).code).toBe('print(df.mean())');
        expect(payload.output).toContain('42.0');
        expect(payload.generated_files).toEqual(
          interpreterResult.generatedFiles,
        );
      });

      it('overrides the agent-execution skip when forced', async () => {
        const context = createTestChatContext({
          interpreterMode: InterpreterMode.ALWAYS,
          agentMode: true,
          model: { agentId: 'agent-123' },
        });

        await enricher.execute(context);

        expect(mockInterpreterExecute).toHaveBeenCalled();
      });

      it('degrades to a failure notice (and failed record) when the sandbox errors', async () => {
        mockInterpreterExecute.mockRejectedValue(new Error('sandbox died'));
        const emitMarker = vi.fn().mockResolvedValue(undefined);
        const context = createTestChatContext({
          interpreterMode: InterpreterMode.ALWAYS,
          emitMarker,
        });

        const result = await enricher.execute(context);

        const lastMessage =
          result.enrichedMessages![result.enrichedMessages!.length - 1];
        expect(lastMessage.content).toContain(
          'sandboxed code execution was attempted',
        );
        const marker = emitMarker.mock.calls[0][0] as string;
        expect(marker).toContain('"status":"failed"');
      });
    });

    describe('native routing (Phase 2 — Responses-capable models)', () => {
      const nativeModel = {
        supportsCodeInterpreter: true,
        supportsResponsesApi: true,
        sdk: 'azure-openai' as const,
      };

      it('defers to the Responses path instead of the round-trip', async () => {
        const context = createTestChatContext({
          searchMode: SearchMode.OFF,
          interpreterMode: InterpreterMode.ALWAYS,
          model: nativeModel,
        });

        const result = await enricher.execute(context);

        // No round-trip execution, no router call
        expect(mockInterpreterExecute).not.toHaveBeenCalled();
        expect(mockToolRouterService.determineTool).not.toHaveBeenCalled();
        // The turn is flagged for in-turn execution
        expect(result.nativeCodeInterpreter).toEqual({
          forced: true,
          inputFiles: [],
        });
      });

      it('flags forced=false for INTELLIGENT mode', async () => {
        const context = createTestChatContext({
          searchMode: SearchMode.OFF,
          interpreterMode: InterpreterMode.INTELLIGENT,
          model: nativeModel,
        });

        const result = await enricher.execute(context);

        expect(result.nativeCodeInterpreter).toEqual({
          forced: false,
          inputFiles: [],
        });
        expect(mockInterpreterExecute).not.toHaveBeenCalled();
      });

      it('keeps the round-trip when the turn carries MCP servers', async () => {
        const context = createTestChatContext({
          searchMode: SearchMode.OFF,
          interpreterMode: InterpreterMode.ALWAYS,
          model: nativeModel,
        });
        context.mcpServers = [{ id: 's1' } as any];

        const result = await enricher.execute(context);

        expect(result.nativeCodeInterpreter).toBeUndefined();
        expect(mockInterpreterExecute).toHaveBeenCalled();
      });

      it('keeps the round-trip for non-capable models', async () => {
        const context = createTestChatContext({
          searchMode: SearchMode.OFF,
          interpreterMode: InterpreterMode.ALWAYS,
          model: { sdk: 'anthropic-foundry' as const },
        });

        const result = await enricher.execute(context);

        expect(result.nativeCodeInterpreter).toBeUndefined();
        expect(mockInterpreterExecute).toHaveBeenCalled();
      });
    });

    describe('intelligent routing', () => {
      it('asks the router to consider code execution and honors its decision', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: ['code_interpreter'],
          codeTask: 'Compute the mean of the attached data',
        });
        const context = createTestChatContext({
          searchMode: SearchMode.OFF,
          interpreterMode: InterpreterMode.INTELLIGENT,
        });

        await enricher.execute(context);

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({ considerCodeExecution: true }),
        );
        expect(mockInterpreterExecute).toHaveBeenCalledWith(
          expect.objectContaining({
            task: 'Compute the mean of the attached data',
          }),
        );
      });

      it('ignores a code_interpreter decision when interpreter mode is OFF', async () => {
        mockToolRouterService.determineTool.mockResolvedValue({
          tools: ['code_interpreter'],
          codeTask: 'anything',
        });
        const context = createTestChatContext({
          searchMode: SearchMode.INTELLIGENT,
          interpreterMode: InterpreterMode.OFF,
        });

        await enricher.execute(context);

        expect(mockToolRouterService.determineTool).toHaveBeenCalledWith(
          expect.objectContaining({ considerCodeExecution: false }),
        );
        expect(mockInterpreterExecute).not.toHaveBeenCalled();
      });
    });
  });
});
