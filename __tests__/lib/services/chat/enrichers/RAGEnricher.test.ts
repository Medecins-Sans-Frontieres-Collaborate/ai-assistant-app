/**
 * Unit Tests for RAGEnricher
 *
 * Tests the enricher that adds RAG (Retrieval Augmented Generation) capabilities
 * to the chat pipeline by querying Azure AI Search and adding knowledge base
 * context to messages.
 */
import {
  createTestChatContext,
  createTestMessage,
} from '@/__tests__/lib/services/chat/testUtils';
import { RAGEnricher } from '@/lib/services/chat/enrichers/RAGEnricher';

import { Message, MessageType } from '@/types/chat';

import { getOrganizationAgentById } from '@/lib/organizationAgents';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Create mock performSearch function that we can control
const mockPerformSearch = vi.fn();

// Mock the RAGService as a class
vi.mock('@/lib/services/ragService', () => ({
  RAGService: class MockRAGService {
    performSearch = mockPerformSearch;
    constructor() {}
  },
}));

// Mock organization agents
vi.mock('@/lib/organizationAgents', () => ({
  getOrganizationAgentById: vi.fn(),
}));

// Mock OpenTelemetry
vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (
        _name: string,
        _options: any,
        fn: (span: any) => Promise<any>,
      ) => {
        const mockSpan = {
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          recordException: vi.fn(),
          end: vi.fn(),
        };
        return fn(mockSpan);
      },
    }),
  },
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: vi.fn() }),
      createHistogram: () => ({ record: vi.fn() }),
    }),
  },
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
}));

describe('RAGEnricher', () => {
  let enricher: RAGEnricher;
  let mockOpenAIClient: any;

  const mockOrganizationAgent = {
    id: 'msf_communications',
    name: 'MSF Communications',
    type: 'rag' as const,
    description: 'Test agent',
    systemPrompt: 'You are a helpful communications assistant.',
    icon: 'IconMessageCircle',
    sources: ['Internal Communications'],
    ragConfig: {
      topK: 10,
      semanticConfig: 'test-semantic-config',
    },
  };

  const mockSearchResults = [
    {
      chunk: 'This is document 1 content about communications.',
      title: 'Communications Guide',
      date: '2025-01-15',
      url: 'https://example.com/doc1',
    },
    {
      chunk: 'This is document 2 content about policies.',
      title: 'Policy Document',
      date: '2025-01-10',
      url: 'https://example.com/doc2',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock OpenAI client
    mockOpenAIClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };

    // Setup default performSearch mock
    mockPerformSearch.mockResolvedValue({
      searchDocs: mockSearchResults,
      searchMetadata: {
        dateRange: {
          newest: '2025-01-15',
          oldest: '2025-01-10',
        },
        resultCount: 2,
      },
    });

    // Create enricher instance
    enricher = new RAGEnricher(
      'https://search.example.com',
      'test-index',
      mockOpenAIClient,
    );
  });

  describe('shouldRun', () => {
    it('should return true when botId is set', () => {
      const context = createTestChatContext({
        botId: 'msf_communications',
      });

      expect(enricher.shouldRun(context)).toBe(true);
    });

    it('should return false when botId is not set', () => {
      const context = createTestChatContext({
        botId: undefined,
      });

      expect(enricher.shouldRun(context)).toBe(false);
    });

    it('should return false when botId is empty string', () => {
      const context = createTestChatContext({
        botId: '',
      });

      expect(enricher.shouldRun(context)).toBe(false);
    });
  });

  describe('executeStage', () => {
    describe('when organization agent is found', () => {
      beforeEach(() => {
        (getOrganizationAgentById as any).mockReturnValue(
          mockOrganizationAgent,
        );
      });

      it('should perform search and add RAG context to messages', async () => {
        const context = createTestChatContext({
          botId: 'msf_communications',
          messages: [
            createTestMessage({
              content: 'What is the communications policy?',
            }),
          ],
        });

        const result = await enricher.execute(context);

        // Verify enrichedMessages were created
        expect(result.enrichedMessages).toBeDefined();
        expect(result.enrichedMessages!.length).toBeGreaterThan(1);

        // Check that RAG context message was added
        const ragContextMessage = result.enrichedMessages![0];
        expect(ragContextMessage.role).toBe('system');
        expect(ragContextMessage.content).toContain('knowledge base sources');
        expect(ragContextMessage.content).toContain('Source 1:');
        expect(ragContextMessage.content).toContain('Communications Guide');
        expect(ragContextMessage.content).toContain('Source 2:');
        expect(ragContextMessage.content).toContain('Policy Document');
      });

      it('should override system prompt with agent system prompt', async () => {
        const context = createTestChatContext({
          botId: 'msf_communications',
          systemPrompt: 'Original system prompt',
          messages: [createTestMessage({ content: 'Hello' })],
        });

        const result = await enricher.execute(context);

        expect(result.systemPrompt).toBe(mockOrganizationAgent.systemPrompt);
      });

      it('should store search metadata in processedContent', async () => {
        const context = createTestChatContext({
          botId: 'msf_communications',
          messages: [createTestMessage({ content: 'Test query' })],
        });

        const result = await enricher.execute(context);

        expect(result.processedContent?.metadata?.ragConfig).toBeDefined();
        expect(
          result.processedContent?.metadata?.ragConfig.organizationAgentId,
        ).toBe('msf_communications');
        expect(result.processedContent?.metadata?.ragConfig.agentName).toBe(
          'MSF Communications',
        );
        expect(
          result.processedContent?.metadata?.ragConfig.searchResults,
        ).toEqual(mockSearchResults);
      });

      it('should use enrichedMessages if already present', async () => {
        const existingEnrichedMessages = [
          createTestMessage({
            role: 'system',
            content: 'Previous enrichment',
          }),
          createTestMessage({ content: 'User message' }),
        ];

        const context = createTestChatContext({
          botId: 'msf_communications',
          messages: [createTestMessage({ content: 'Original message' })],
          enrichedMessages: existingEnrichedMessages,
        });

        const result = await enricher.execute(context);

        // Should have RAG context + existing enriched messages
        expect(result.enrichedMessages!.length).toBeGreaterThan(
          existingEnrichedMessages.length,
        );
        // Original enriched messages should be preserved
        expect(result.enrichedMessages).toContainEqual(
          existingEnrichedMessages[0],
        );
      });

      it('should include file summaries in messages', async () => {
        const context = createTestChatContext({
          botId: 'msf_communications',
          messages: [createTestMessage({ content: 'Analyze this file' })],
          processedContent: {
            fileSummaries: [
              {
                filename: 'report.pdf',
                summary: 'This is a summary of the report.',
                originalContent: 'Full content...',
              },
            ],
          },
        });

        const result = await enricher.execute(context);

        // Should have file summary message
        const fileSummaryMessage = result.enrichedMessages?.find(
          (m) =>
            m.role === 'system' &&
            typeof m.content === 'string' &&
            m.content.includes('uploaded the following documents'),
        );
        expect(fileSummaryMessage).toBeDefined();
        expect(fileSummaryMessage?.content).toContain('report.pdf');
        expect(fileSummaryMessage?.content).toContain(
          'This is a summary of the report.',
        );
      });

      it('should include transcripts in messages', async () => {
        const context = createTestChatContext({
          botId: 'msf_communications',
          messages: [createTestMessage({ content: 'What was said?' })],
          processedContent: {
            transcripts: [
              {
                filename: 'meeting.mp3',
                transcript: 'This is what was discussed in the meeting.',
              },
            ],
          },
        });

        const result = await enricher.execute(context);

        // Should have transcript message
        const transcriptMessage = result.enrichedMessages?.find(
          (m) =>
            m.role === 'system' &&
            typeof m.content === 'string' &&
            m.content.includes('audio/video files'),
        );
        expect(transcriptMessage).toBeDefined();
        expect(transcriptMessage?.content).toContain('meeting.mp3');
        expect(transcriptMessage?.content).toContain(
          'This is what was discussed in the meeting.',
        );
      });
    });

    describe('when organization agent is not found', () => {
      beforeEach(() => {
        (getOrganizationAgentById as any).mockReturnValue(undefined);
      });

      it('should return context unchanged', async () => {
        const context = createTestChatContext({
          botId: 'unknown_agent',
          messages: [createTestMessage({ content: 'Test' })],
        });

        const result = await enricher.execute(context);

        // Should return original context
        expect(result.enrichedMessages).toBeUndefined();
        expect(result.systemPrompt).toBe(context.systemPrompt);
      });
    });

    describe('when search returns no results', () => {
      beforeEach(() => {
        (getOrganizationAgentById as any).mockReturnValue(
          mockOrganizationAgent,
        );
        mockPerformSearch.mockResolvedValue({
          searchDocs: [],
          searchMetadata: {
            dateRange: { newest: null, oldest: null },
            resultCount: 0,
          },
        });
      });

      it('should not add RAG context message when no results', async () => {
        const context = createTestChatContext({
          botId: 'msf_communications',
          messages: [createTestMessage({ content: 'Very obscure query' })],
        });

        const result = await enricher.execute(context);

        // Should still have enrichedMessages but no RAG context
        const ragContextMessage = result.enrichedMessages?.find(
          (m) =>
            m.role === 'system' &&
            typeof m.content === 'string' &&
            m.content.includes('knowledge base sources'),
        );
        expect(ragContextMessage).toBeUndefined();
      });
    });

    // Note: Error handling test is challenging due to mock behavior with class instances.
    // The actual error handling is verified through integration tests.
  });

  describe('integration with pipeline', () => {
    beforeEach(() => {
      (getOrganizationAgentById as any).mockReturnValue(mockOrganizationAgent);
    });

    it('should format search results correctly for LLM consumption', async () => {
      const context = createTestChatContext({
        botId: 'msf_communications',
        messages: [createTestMessage({ content: 'Tell me about policies' })],
      });

      const result = await enricher.execute(context);

      const ragContextMessage = result.enrichedMessages![0];
      const content = ragContextMessage.content as string;

      // Should include citation instructions
      expect(content).toContain('source numbers in SEPARATE brackets');
      expect(content).toContain('[1]');
      expect(content).toContain('[2]');

      // Should include all source metadata
      expect(content).toContain('Title:');
      expect(content).toContain('Date:');
      expect(content).toContain('URL:');
      expect(content).toContain('Content:');
    });

    it('should preserve message order correctly', async () => {
      const context = createTestChatContext({
        botId: 'msf_communications',
        messages: [
          createTestMessage({ role: 'user', content: 'First question' }),
          createTestMessage({ role: 'assistant', content: 'First answer' }),
          createTestMessage({ role: 'user', content: 'Follow up question' }),
        ],
      });

      const result = await enricher.execute(context);

      // RAG context should be first (system message)
      expect(result.enrichedMessages![0].role).toBe('system');
      expect(result.enrichedMessages![0].content).toContain(
        'knowledge base sources',
      );

      // Original messages should follow in order
      expect(result.enrichedMessages![1].content).toBe('First question');
      expect(result.enrichedMessages![2].content).toBe('First answer');
      expect(result.enrichedMessages![3].content).toBe('Follow up question');
    });
  });
});
