import { RAGService } from '@/lib/services/ragService';

import { createAzureOpenAIStreamProcessor } from '@/lib/utils/app/stream/streamProcessor';

import { Citation } from '@/types/rag';

import OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock types to match the OpenAI chunk structure
type MockChunk = OpenAI.Chat.Completions.ChatCompletionChunk & {
  choices: [{ delta: { content?: string } }];
};

describe('Azure OpenAI Stream Processor', () => {
  let mockRAGService: RAGService;

  // Helper to create mock async iterable response
  function createMockResponse(chunks: MockChunk[]): AsyncIterable<MockChunk> {
    let iterator = 0;
    return {
      [Symbol.asyncIterator](): AsyncIterator<MockChunk> {
        return {
          next(): Promise<IteratorResult<MockChunk>> {
            if (iterator < chunks.length) {
              return Promise.resolve({
                done: false,
                value: chunks[iterator++],
              });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  }

  // Helper to read stream content
  async function readStreamContent(stream: ReadableStream): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let content = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        content += decoder.decode(value);
      }
    } finally {
      reader.releaseLock();
    }

    // Extract just the content part, not the citations/metadata
    const metadataStart = content.indexOf('\n\n<<<METADATA_START>>>');
    return metadataStart > -1 ? content.slice(0, metadataStart) : content;
  }

  beforeEach(() => {
    // Create a real RAGService instance with mocked dependencies
    const mockSearchClient = {
      search: vi.fn().mockResolvedValue({
        results: [
          {
            // Mock result for citation [1] (Source 1)
            document: {
              title: 'Test Source 1',
              date: '2023-01-01',
              url: 'https://example.com/1',
              content: 'Test content 1',
            },
          },
          {
            // Mock result for citation [2] (Source 2)
            document: {
              title: 'Test Source 2',
              date: '2023-01-02',
              url: 'https://example.com/2',
              content: 'Test content 2',
            },
          },
        ],
      }),
    };

    const mockOpenAIClient = {};

    mockRAGService = new RAGService(
      'test-endpoint',
      'test-index',
      'test-api-key',
      mockOpenAIClient as any,
    );

    // Spy on methods to verify they're called
    vi.spyOn(mockRAGService, 'getCurrentCitations');
  });

  it('processes a non-RAG stream correctly', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' World' } }] },
    ] as MockChunk[];

    const mockResponse = createMockResponse(chunks);
    const stream = createAzureOpenAIStreamProcessor(mockResponse);

    const content = await readStreamContent(stream);

    expect(content).toBe('Hello World');
  });

  it('processes a RAG stream with citations', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hello [1]' } }] },
      { choices: [{ delta: { content: ' World [2]' } }] },
    ] as MockChunk[];

    const mockResponse = createMockResponse(chunks);
    // Mock getCurrentCitations to return expected citations
    vi.spyOn(mockRAGService, 'getCurrentCitations').mockReturnValue([
      {
        title: 'Test Source 1',
        date: '2023-01-01',
        url: 'https://example.com/1',
        number: 1,
      } as Citation,
      {
        title: 'Test Source 2',
        date: '2023-01-02',
        url: 'https://example.com/2',
        number: 2,
      } as Citation,
    ]);

    const stream = createAzureOpenAIStreamProcessor(
      mockResponse,
      mockRAGService,
    );

    const content = await readStreamContent(stream);

    expect(content).toBe('Hello [1] World [2]');
    expect(mockRAGService.getCurrentCitations).toHaveBeenCalledTimes(1);

    const finalCitations = mockRAGService.getCurrentCitations();
    expect(finalCitations).toHaveLength(2);
    expect(finalCitations[0]).toMatchObject({
      title: 'Test Source 1',
      date: '2023-01-01',
      url: 'https://example.com/1',
      number: 1,
    });
    expect(finalCitations[1]).toMatchObject({
      title: 'Test Source 2',
      date: '2023-01-02',
      url: 'https://example.com/2',
      number: 2,
    });
  });

  it('verifies citation data is appended to the stream', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hello [1]' } }] },
      { choices: [{ delta: { content: ' World [2]' } }] },
    ] as MockChunk[];

    const mockResponse = createMockResponse(chunks);
    // Mock getCurrentCitations to return expected citations
    vi.spyOn(mockRAGService, 'getCurrentCitations').mockReturnValue([
      {
        title: 'Test Source 1',
        date: '2023-01-01',
        url: 'https://example.com/1',
        number: 1,
      } as Citation,
      {
        title: 'Test Source 2',
        date: '2023-01-02',
        url: 'https://example.com/2',
        number: 2,
      } as Citation,
    ]);

    const stream = createAzureOpenAIStreamProcessor(
      mockResponse,
      mockRAGService,
    );

    // Read the entire stream content including citations
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullContent += decoder.decode(value);
      }
    } finally {
      reader.releaseLock();
    }

    // Verify the citations are appended correctly with new metadata format
    expect(fullContent).toContain('Hello [1] World [2]');
    expect(fullContent).toContain('<<<METADATA_START>>>');
    expect(fullContent).toContain('<<<METADATA_END>>>');
    expect(fullContent).toContain('"title":"Test Source 1"');
    expect(fullContent).toContain('"title":"Test Source 2"');
  });

  it('handles stream with empty chunks', async () => {
    const chunks = [
      { choices: [{ delta: {} }] },
      { choices: [{ delta: { content: '' } }] },
    ] as MockChunk[];

    const mockResponse = createMockResponse(chunks);
    const stream = createAzureOpenAIStreamProcessor(mockResponse);

    const content = await readStreamContent(stream);

    expect(content).toBe('');
  });

  it('propagates stream errors', async () => {
    const errorResponse = {
      [Symbol.asyncIterator](): AsyncIterator<MockChunk> {
        return {
          next(): Promise<IteratorResult<MockChunk>> {
            return Promise.reject(new Error('Stream error'));
          },
        };
      },
    };

    const stream = createAzureOpenAIStreamProcessor(errorResponse);

    await expect(readStreamContent(stream)).rejects.toThrow('Stream error');
  });

  it('handles RAG service citation processing errors', async () => {
    vi.spyOn(mockRAGService, 'processCitationInChunk').mockImplementation(
      () => {
        throw new Error('Citation processing error');
      },
    );

    const chunks = [
      { choices: [{ delta: { content: 'Hello' } }] },
    ] as MockChunk[];

    const mockResponse = createMockResponse(chunks);
    const stream = createAzureOpenAIStreamProcessor(
      mockResponse,
      mockRAGService,
    );

    await expect(readStreamContent(stream)).rejects.toThrow(
      'Citation processing error',
    );
  });
});
