import { AgentChatService } from '@/lib/services/chat/AgentChatService';
import { WebSearchTool } from '@/lib/services/chat/tools/WebSearchTool';
import {
  searchNewsFanOut,
  searchNewsParallel,
} from '@/lib/services/chat/tools/newsSearch';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { env } from '@/config/environment';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/chat/tools/newsSearch', () => ({
  searchNewsFanOut: vi.fn(),
  searchNewsParallel: vi.fn(),
}));

describe('WebSearchTool', () => {
  let webSearchTool: WebSearchTool;
  let mockAgentChatService: AgentChatService;

  const priorProvider = env.WEB_SEARCH_PROVIDER;
  afterAll(() => {
    (env as any).WEB_SEARCH_PROVIDER = priorProvider;
  });

  beforeEach(() => {
    // These tests exercise the Bing-agent path explicitly.
    (env as any).WEB_SEARCH_PROVIDER = 'bing-agent';
    // Create mock AgentChatService
    mockAgentChatService = {
      executeWebSearchTool: vi.fn(),
    } as any;

    webSearchTool = new WebSearchTool(mockAgentChatService);
  });

  describe('execute', () => {
    it('should return search results on success', async () => {
      const mockResults = {
        text: 'Search results about AI',
        citations: [
          {
            number: 1,
            url: 'https://example.com',
            title: 'AI Article',
            date: '2024-01-01',
          },
          {
            number: 2,
            url: 'https://example2.com',
            title: 'AI Research',
            date: '2024-01-02',
          },
        ],
      };

      vi.mocked(mockAgentChatService.executeWebSearchTool).mockResolvedValue(
        mockResults,
      );

      const result = await webSearchTool.execute({
        searchQuery: 'artificial intelligence',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user: { email: 'test@example.com' } as any,
      });

      expect(result.text).toBe('Search results about AI');
      expect(result.citations).toHaveLength(2);
      expect(result.citations![0].url).toBe('https://example.com');
    });

    it('should return error message when search fails', async () => {
      const error = new Error('API quota exceeded');
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockRejectedValue(
        error,
      );

      const result = await webSearchTool.execute({
        searchQuery: 'test query',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user: { email: 'test@example.com' } as any,
      });

      expect(result.text).toContain('Web search encountered an issue');
      expect(result.text).toContain('API quota exceeded');
      expect(result.citations).toEqual([]);
    });

    it('should handle network errors gracefully', async () => {
      const error = new Error('Network timeout');
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockRejectedValue(
        error,
      );

      const result = await webSearchTool.execute({
        searchQuery: 'test query',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user: { email: 'test@example.com' } as any,
      });

      expect(result.text).toContain('Web search encountered an issue');
      expect(result.text).toContain('Network timeout');
      expect(result.citations).toEqual([]);
    });

    it('should handle unknown errors', async () => {
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockRejectedValue(
        'Unknown error',
      );

      const result = await webSearchTool.execute({
        searchQuery: 'test query',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user: { email: 'test@example.com' } as any,
      });

      expect(result.text).toContain('Web search encountered an issue');
      expect(result.text).toContain('Unknown search error');
      expect(result.citations).toEqual([]);
    });

    it('should return empty citations array when citations are missing', async () => {
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockResolvedValue({
        text: 'Some results',
        citations: [],
      });

      const result = await webSearchTool.execute({
        searchQuery: 'test',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user: { email: 'test@example.com' } as any,
      });

      expect(result.citations).toEqual([]);
      expect(result.text).toBe('Some results');
    });
  });

  describe('feed provider routing', () => {
    beforeEach(() => {
      vi.mocked(searchNewsFanOut).mockClear();
      vi.mocked(searchNewsParallel).mockClear();
    });

    it('fans out across queries via searchNewsFanOut when multiple queries arrive', async () => {
      (env as any).WEB_SEARCH_PROVIDER = 'news';
      vi.mocked(searchNewsFanOut).mockResolvedValue({
        text: 'Merged digest',
        citations: [
          { number: 1, title: 'A', url: 'https://a.example', date: '' },
        ],
        providersUsed: ['google-news'],
      });

      const result = await webSearchTool.execute({
        searchQuery: 'france strikes',
        searchQueries: ['france strikes', 'germany rail dispute'],
        user: { email: 'test@example.com' } as any,
      });

      expect(searchNewsFanOut).toHaveBeenCalledWith(
        ['france strikes', 'germany rail dispute'],
        expect.objectContaining({ resultCount: 8 }),
      );
      expect(searchNewsParallel).not.toHaveBeenCalled();
      expect(result.text).toBe('Merged digest');
    });

    it('uses the normal parallel provider path for a single query', async () => {
      (env as any).WEB_SEARCH_PROVIDER = 'news';
      vi.mocked(searchNewsParallel).mockResolvedValue({
        text: 'Digest',
        citations: [],
        providersUsed: [],
      });

      await webSearchTool.execute({
        searchQuery: 'india protests',
        searchQueries: ['india protests'],
        user: { email: 'test@example.com' } as any,
      });

      expect(searchNewsFanOut).not.toHaveBeenCalled();
      expect(searchNewsParallel).toHaveBeenCalled();
    });

    it('ignores fan-out on the bing-agent path (agent expands queries itself)', async () => {
      (env as any).WEB_SEARCH_PROVIDER = 'bing-agent';
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockResolvedValue({
        text: 'Agent results',
        citations: [],
      });

      await webSearchTool.execute({
        searchQuery: 'primary query',
        searchQueries: ['primary query', 'secondary query'],
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user: { email: 'test@example.com' } as any,
      });

      expect(searchNewsFanOut).not.toHaveBeenCalled();
      expect(mockAgentChatService.executeWebSearchTool).toHaveBeenCalledWith(
        expect.objectContaining({ searchQuery: 'primary query' }),
      );
    });
  });

  describe('tool metadata', () => {
    it('should have correct tool type', () => {
      expect(webSearchTool.type).toBe('web_search');
    });

    it('should have descriptive name', () => {
      expect(webSearchTool.name).toBe('Web Search');
    });

    it('should have description', () => {
      expect(webSearchTool.description.toLowerCase()).toContain('web');
      expect(webSearchTool.description.toLowerCase()).toContain('search');
    });
  });
});
