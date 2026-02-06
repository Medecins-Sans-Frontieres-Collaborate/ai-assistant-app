/**
 * Unit Tests for RAGService
 *
 * Tests the service that handles Retrieval-Augmented Generation (RAG) operations
 * including Azure AI Search queries and query reformulation using the Foundry LLM.
 */
// Import after mocks are set up
import { RAGService } from '@/lib/services/ragService';

import { Message } from '@/types/chat';

import { getOrganizationAgentById } from '@/lib/organizationAgents';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Create mock search function that we can control
const mockSearch = vi.fn();

// Mock Azure Search SDK - must be before import
vi.mock('@azure/search-documents', () => ({
  SearchClient: class MockSearchClient {
    search = mockSearch;
    constructor() {}
  },
}));

// Mock Azure Identity
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn(),
}));

// Mock organization agents
vi.mock('@/lib/organizationAgents', () => ({
  getOrganizationAgentById: vi.fn(),
}));

describe('RAGService', () => {
  let ragService: RAGService;
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
      topK: 5,
      semanticConfig: 'custom-semantic-config',
    },
  };

  // Helper to create async generator for search results
  // Each result includes document, score, and rerankerScore (rerankerScore defaults to 3.0 for relevance)
  const createMockSearchResults = (
    docs: any[],
    defaultRerankerScore: number = 3.0,
  ) => ({
    results: (async function* () {
      for (const doc of docs) {
        yield {
          document: doc,
          score: doc.score ?? 0.8,
          rerankerScore: doc.rerankerScore ?? defaultRerankerScore,
        };
      }
    })(),
  });

  // Use recent dates (within 1 year) to avoid date filtering
  const defaultSearchDocs = [
    {
      chunk: 'Document 1 content about communications policy.',
      chunk_id: 'doc1-chunk-1',
      title: 'Communications Policy Guide',
      date: '2025-12-15',
      url: 'https://example.com/doc1',
    },
    {
      chunk: 'Document 2 content about internal procedures.',
      chunk_id: 'doc2-chunk-1',
      title: 'Internal Procedures Manual',
      date: '2025-12-10',
      url: 'https://example.com/doc2',
    },
  ];

  const mockUser = {
    id: 'test-user-123',
    email: 'test@example.com',
    name: 'Test User',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset the mock search function
    mockSearch.mockReset();
    mockSearch.mockReturnValue(createMockSearchResults(defaultSearchDocs));

    // Mock OpenAI client for query reformulation
    mockOpenAIClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: 'reformulated search query',
                },
              },
            ],
          }),
        },
      },
    };

    // Create RAGService instance
    ragService = new RAGService(
      'https://search.example.com',
      'test-index',
      mockOpenAIClient,
    );

    // Mock organization agent lookup
    (getOrganizationAgentById as any).mockReturnValue(mockOrganizationAgent);
  });

  describe('performSearch', () => {
    const createTestMessages = (content: string): Message[] => [
      { role: 'user', content },
    ];

    it('should perform search with correct parameters', async () => {
      const messages = createTestMessages('What is the communications policy?');

      // Reset mock to return fresh async generator with recent dates
      mockSearch.mockReturnValue(
        createMockSearchResults([
          {
            chunk: 'Test content',
            chunk_id: 'test-chunk',
            title: 'Test Title',
            date: '2025-12-15',
            url: 'https://example.com/test',
          },
        ]),
      );

      const result = await ragService.performSearch(
        messages,
        'msf_communications',
        mockUser as any,
      );

      expect(mockSearch).toHaveBeenCalled();
      expect(result.searchDocs).toBeDefined();
      expect(result.searchMetadata).toBeDefined();
    });

    it('should fetch 30 results for quality filtering and deduplication', async () => {
      const messages = createTestMessages('Test query');

      mockSearch.mockReturnValue(createMockSearchResults([]));

      await ragService.performSearch(
        messages,
        'msf_communications',
        mockUser as any,
      );

      // Upstream implementation always fetches 30 results for quality filtering
      expect(mockSearch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          top: 30,
        }),
      );
    });

    it('should use semantic search with reranking', async () => {
      const messages = createTestMessages('Test query');

      mockSearch.mockReturnValue(createMockSearchResults([]));

      await ragService.performSearch(
        messages,
        'msf_communications',
        mockUser as any,
      );

      // Verify search was called with semantic search options
      expect(mockSearch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          queryType: 'semantic',
          semanticSearchOptions: expect.objectContaining({
            configurationName: 'custom-semantic-config',
            captions: { captionType: 'extractive' },
            answers: { answerType: 'extractive', count: 3 },
          }),
        }),
      );
    });

    it('should deduplicate results by chunk_id and limit chunks per article', async () => {
      mockSearch.mockReturnValue(
        createMockSearchResults([
          {
            chunk: 'Content 1',
            chunk_id: 'chunk-1',
            title: 'Doc 1',
            date: '2025-12-15',
            url: 'https://example.com/article-1',
          },
          {
            chunk: 'Content 1 duplicate chunk',
            chunk_id: 'chunk-1', // Duplicate chunk_id
            title: 'Doc 1',
            date: '2025-12-15',
            url: 'https://example.com/article-1',
          },
          {
            chunk: 'Content 2 from same article',
            chunk_id: 'chunk-2',
            title: 'Doc 1',
            date: '2025-12-15',
            url: 'https://example.com/article-1', // Same URL, different chunk
          },
          {
            chunk: 'Content 3 from same article',
            chunk_id: 'chunk-3',
            title: 'Doc 1',
            date: '2025-12-15',
            url: 'https://example.com/article-1', // Same URL, third chunk (should be filtered)
          },
          {
            chunk: 'Content 4 from different article',
            chunk_id: 'chunk-4',
            title: 'Doc 2',
            date: '2025-12-14',
            url: 'https://example.com/article-2',
          },
        ]),
      );

      const messages = createTestMessages('Test query');
      const result = await ragService.performSearch(
        messages,
        'msf_communications',
        mockUser as any,
      );

      // Should have 3 results:
      // - chunk-1 from article-1 (first chunk)
      // - chunk-2 from article-1 (second chunk, within MAX_CHUNKS_PER_ARTICLE=2)
      // - chunk-4 from article-2 (first chunk from different article)
      // chunk-1 duplicate is removed, chunk-3 is filtered by MAX_CHUNKS_PER_ARTICLE
      expect(result.searchDocs).toHaveLength(3);
    });

    it('should calculate date range from results', async () => {
      mockSearch.mockReturnValue(
        createMockSearchResults([
          {
            chunk: 'Content',
            chunk_id: 'oldest-chunk',
            title: 'Oldest',
            date: '2025-12-01',
            url: 'https://example.com/1',
          },
          {
            chunk: 'Content',
            chunk_id: 'newest-chunk',
            title: 'Newest',
            date: '2025-12-20',
            url: 'https://example.com/2',
          },
          {
            chunk: 'Content',
            chunk_id: 'middle-chunk',
            title: 'Middle',
            date: '2025-12-10',
            url: 'https://example.com/3',
          },
        ]),
      );

      const messages = createTestMessages('Test query');
      const result = await ragService.performSearch(
        messages,
        'msf_communications',
        mockUser as any,
      );

      expect(result.searchMetadata.dateRange.oldest).toBe('2025-12-01');
      expect(result.searchMetadata.dateRange.newest).toBe('2025-12-20');
    });

    it('should throw error when agent not found', async () => {
      (getOrganizationAgentById as any).mockReturnValue(undefined);

      const messages = createTestMessages('Test query');

      await expect(
        ragService.performSearch(messages, 'unknown_agent', mockUser as any),
      ).rejects.toThrow('Organization agent unknown_agent not found');
    });

    it('should use reformulated query for follow-up questions', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'What is the policy?' },
        { role: 'assistant', content: 'The policy covers...' },
        { role: 'user', content: 'Tell me more about that' }, // Follow-up
      ];

      mockSearch.mockReturnValue(createMockSearchResults([]));

      await ragService.performSearch(
        messages,
        'msf_communications',
        mockUser as any,
      );

      // Should have called OpenAI for query reformulation
      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalled();

      // Search should use the reformulated query
      expect(mockSearch).toHaveBeenCalledWith(
        'reformulated search query',
        expect.any(Object),
      );
    });

    it('should use original query for first question', async () => {
      const messages = createTestMessages('What is the communications policy?');

      mockSearch.mockReturnValue(createMockSearchResults([]));

      await ragService.performSearch(
        messages,
        'msf_communications',
        mockUser as any,
      );

      // Should NOT have called OpenAI for query reformulation
      expect(mockOpenAIClient.chat.completions.create).not.toHaveBeenCalled();

      // Search should use the original query
      expect(mockSearch).toHaveBeenCalledWith(
        'What is the communications policy?',
        expect.any(Object),
      );
    });
  });

  describe('reformulateQuery', () => {
    it('should call gpt-5-mini for query reformulation', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Original query' }];

      await ragService.reformulateQuery(messages);

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5-mini',
        }),
      );
    });

    it('should include conversation history in reformulation request', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow up question' },
      ];

      await ragService.reformulateQuery(messages);

      // Check that conversation history was included
      const call = mockOpenAIClient.chat.completions.create.mock.calls[0][0];
      const userMessage = call.messages.find(
        (m: any) => m.role === 'user',
      )?.content;

      expect(userMessage).toContain('First question');
      expect(userMessage).toContain('First answer');
      expect(userMessage).toContain('Follow up question');
    });

    it('should return original query on error', async () => {
      mockOpenAIClient.chat.completions.create.mockRejectedValue(
        new Error('API error'),
      );

      const messages: Message[] = [{ role: 'user', content: 'Original query' }];

      const result = await ragService.reformulateQuery(messages);

      // Should fall back to original query
      expect(result).toBe('Original query');
    });

    it('should use low temperature for focused query generation', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Test query' }];

      await ragService.reformulateQuery(messages);

      const call = mockOpenAIClient.chat.completions.create.mock.calls[0][0];

      // Use low temperature for focused, deterministic query generation
      expect(call.temperature).toBe(0.2);
    });
  });

  describe('extractQuery', () => {
    it('should extract query from last user message', () => {
      const messages: Message[] = [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Last message - this is the query' },
      ];

      const query = ragService.extractQuery(messages);

      expect(query).toBe('Last message - this is the query');
    });

    it('should throw error when no user message found', () => {
      const messages: Message[] = [
        { role: 'assistant', content: 'Only assistant message' },
      ];

      expect(() => ragService.extractQuery(messages)).toThrow(
        'No user message found',
      );
    });

    it('should handle empty messages array', () => {
      expect(() => ragService.extractQuery([])).toThrow(
        'No user message found',
      );
    });
  });

  describe('citation processing', () => {
    it('should process citations in chunk correctly', () => {
      ragService.initCitationTracking();

      const result = ragService.processCitationInChunk(
        'This is text with [1] and [2] citations.',
      );

      expect(result).toContain('[1]');
      expect(result).toContain('[2]');
    });

    it('should handle consecutive citations', () => {
      ragService.initCitationTracking();

      const result = ragService.processCitationInChunk(
        'Text with consecutive citations[1][2][3].',
      );

      expect(result).toContain('[1]');
      expect(result).toContain('[2]');
      expect(result).toContain('[3]');
    });

    it('should not process text in brackets', () => {
      ragService.initCitationTracking();

      const result = ragService.processCitationInChunk(
        'Text with [some text] and [1] citation.',
      );

      expect(result).toContain('[some text]');
      expect(result).toContain('[1]');
    });

    it('should deduplicate citations', () => {
      const citations = [
        {
          title: 'Doc 1',
          date: '2025-01-01',
          url: 'https://example.com/1',
          number: 1,
        },
        {
          title: 'Doc 2',
          date: '2025-01-02',
          url: 'https://example.com/1', // Duplicate URL
          number: 2,
        },
        {
          title: 'Doc 3',
          date: '2025-01-03',
          url: 'https://example.com/3',
          number: 3,
        },
      ];

      const deduped = ragService.deduplicateCitations(citations);

      // Should have only 2 unique citations
      expect(deduped).toHaveLength(2);
      expect(deduped[0].url).toBe('https://example.com/1');
      expect(deduped[1].url).toBe('https://example.com/3');
    });
  });
});
