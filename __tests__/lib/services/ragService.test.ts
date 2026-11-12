/**
 * Unit Tests for RAGService
 *
 * Tests the service that handles Retrieval-Augmented Generation (RAG) operations
 * including Azure AI Search queries and residency-routed query reformulation.
 */
// Import after mocks are set up
import { RAGService } from '@/lib/services/ragService';
import type { QueryReformulationRouting } from '@/lib/services/search/queryReformulation';

import { Message } from '@/types/chat';

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

describe('RAGService', () => {
  let ragService: RAGService;
  let mockReformulator: { reformulate: ReturnType<typeof vi.fn> };
  const routing: QueryReformulationRouting = { region: 'EU' };

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

    // Mock the residency-routed reformulator
    mockReformulator = {
      reformulate: vi.fn().mockResolvedValue({
        query: 'reformulated search query',
        source: 'auxiliary',
      }),
    };

    // Create RAGService instance
    ragService = new RAGService(
      'https://search.example.com',
      'test-index',
      mockReformulator as any,
    );
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
        mockOrganizationAgent as any,
        mockUser as any,
        routing,
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
        mockOrganizationAgent as any,
        mockUser as any,
        routing,
      );

      // Fetches topK * 2 (max 20) for deduplication buffer
      // Agent has topK: 5, so fetchCount = min(5 * 2, 20) = 10
      expect(mockSearch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          top: 10,
        }),
      );
    });

    it('should use semantic search with reranking', async () => {
      const messages = createTestMessages('Test query');

      mockSearch.mockReturnValue(createMockSearchResults([]));

      await ragService.performSearch(
        messages,
        mockOrganizationAgent as any,
        mockUser as any,
        routing,
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
        mockOrganizationAgent as any,
        mockUser as any,
        routing,
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
        mockOrganizationAgent as any,
        mockUser as any,
        routing,
      );

      expect(result.searchMetadata.dateRange.oldest).toBe('2025-12-01');
      expect(result.searchMetadata.dateRange.newest).toBe('2025-12-20');
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
        mockOrganizationAgent as any,
        mockUser as any,
        routing,
      );

      // Should have asked the reformulator, under the turn's routing
      expect(mockReformulator.reformulate).toHaveBeenCalledWith(
        expect.objectContaining({ userPrompt: expect.any(String) }),
        routing,
      );

      // Search should use the reformulated query
      expect(mockSearch).toHaveBeenCalledWith(
        'reformulated search query',
        expect.any(Object),
      );
    });

    it('should reformulate even first question for temporal handling', async () => {
      const messages = createTestMessages('What is the communications policy?');

      mockSearch.mockReturnValue(createMockSearchResults([]));

      await ragService.performSearch(
        messages,
        mockOrganizationAgent as any,
        mockUser as any,
        routing,
      );

      // Reformulation runs on every query, not just follow-ups
      expect(mockReformulator.reformulate).toHaveBeenCalledTimes(1);

      // Search should use the reformulated query
      expect(mockSearch).toHaveBeenCalledWith(
        'reformulated search query',
        expect.any(Object),
      );
    });
  });

  describe('reformulateQuery', () => {
    it('sends the conversation history and the latest question', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow up question' },
      ];

      await ragService.reformulateQuery(messages, routing);

      const [prompt, passedRouting] =
        mockReformulator.reformulate.mock.calls[0];
      expect(prompt.userPrompt).toContain('First question');
      expect(prompt.userPrompt).toContain('First answer');
      expect(prompt.userPrompt).toContain('Original query: Follow up question');
      expect(prompt.systemPrompt).toContain('search query optimizer');
      expect(passedRouting).toBe(routing);
    });

    it('returns the rewrite when one is produced', async () => {
      const result = await ragService.reformulateQuery(
        [{ role: 'user', content: 'Original query' }],
        routing,
      );
      expect(result).toBe('reformulated search query');
    });

    it('falls back to the question text of a turn that carries an attachment', async () => {
      mockReformulator.reformulate.mockResolvedValue(undefined);

      const result = await ragService.reformulateQuery(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What does the memo say about Gaza?' },
              { type: 'file_url', url: 'https://blob/memo.txt' },
            ],
          } as Message,
        ],
        routing,
      );

      // Never empty: an empty query fails the vector search outright.
      expect(result).toBe('What does the memo say about Gaza?');
    });

    it('keeps inlined documents out of the rewrite history', async () => {
      await ragService.reformulateQuery(
        [
          { role: 'system', content: 'Document: ' + 'z'.repeat(20_000) },
          { role: 'user', content: 'Latest news?' },
        ] as Message[],
        routing,
      );

      const [prompt] = mockReformulator.reformulate.mock.calls[0];
      expect(prompt.userPrompt).not.toContain('zzzz');
    });

    it('falls back to the raw question when no path produced a rewrite', async () => {
      mockReformulator.reformulate.mockResolvedValue(undefined);

      const result = await ragService.reformulateQuery(
        [{ role: 'user', content: 'Original query' }],
        routing,
      );

      expect(result).toBe('Original query');
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
