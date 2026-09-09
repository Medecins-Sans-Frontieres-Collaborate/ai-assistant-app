import { AgentChatService } from '@/lib/services/chat/AgentChatService';
import { WebSearchTool } from '@/lib/services/chat/tools/WebSearchTool';
import {
  fetchGoogleNewsHeadlines,
  searchNewsFanOut,
  searchNewsParallel,
} from '@/lib/services/chat/tools/newsSearch';
import { executeResponsesWebSearch } from '@/lib/services/chat/tools/responsesWebSearch';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { env } from '@/config/environment';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/chat/tools/newsSearch', async (importOriginal) => ({
  // Keep the real buildNewsResult — it's the pure digest formatter the
  // combined path relies on.
  ...(await importOriginal<
    typeof import('@/lib/services/chat/tools/newsSearch')
  >()),
  searchNewsFanOut: vi.fn(),
  searchNewsParallel: vi.fn(),
  fetchGoogleNewsHeadlines: vi.fn(),
}));

vi.mock('@/lib/services/chat/tools/responsesWebSearch', () => ({
  executeResponsesWebSearch: vi.fn(),
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

    it('keeps a GDELT-only selection on GDELT even for multi-query turns', async () => {
      vi.mocked(searchNewsParallel).mockResolvedValue({
        text: 'GDELT digest',
        citations: [],
        providersUsed: ['gdelt'],
      });

      await webSearchTool.execute({
        searchQuery: 'kenya elections',
        searchQueries: ['kenya elections', 'nairobi turnout'],
        provider: 'gdelt',
        user: { email: 'test@example.com' } as any,
      });

      expect(searchNewsFanOut).not.toHaveBeenCalled();
      expect(searchNewsParallel).toHaveBeenCalledWith(
        'kenya elections',
        expect.anything(),
        expect.objectContaining({ sources: ['gdelt'] }),
      );
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

  describe('bing-responses provider (Responses API web_search)', () => {
    it('dispatches to the Responses executor with the tuning params, no model needed', async () => {
      vi.mocked(executeResponsesWebSearch).mockResolvedValue({
        text: 'Grounded digest.[1]',
        citations: [
          { number: 1, title: 'Source', url: 'https://a.example', date: '' },
        ],
      });

      const result = await webSearchTool.execute({
        searchQuery: 'renewable energy trends',
        provider: 'bing-responses',
        resultCount: 10,
        freshness: 'week',
        deep: true,
        // No `model` — this path must not require an agent-backed model.
        user: { email: 'test@example.com' } as any,
      });

      expect(executeResponsesWebSearch).toHaveBeenCalledWith({
        searchQuery: 'renewable energy trends',
        resultCount: 10,
        freshness: 'week',
        deep: true,
      });
      expect(mockAgentChatService.executeWebSearchTool).not.toHaveBeenCalled();
      expect(searchNewsFanOut).not.toHaveBeenCalled();
      expect(searchNewsParallel).not.toHaveBeenCalled();
      expect(result.text).toBe('Grounded digest.[1]');
      expect(result.citations).toHaveLength(1);
    });

    it('degrades to the issue note when the executor fails', async () => {
      vi.mocked(executeResponsesWebSearch).mockRejectedValue(
        new Error('web_search tool blocked'),
      );

      const result = await webSearchTool.execute({
        searchQuery: 'anything',
        provider: 'bing-responses',
        user: { email: 'test@example.com' } as any,
      });

      expect(result.text).toContain('Web search encountered an issue');
      expect(result.text).toContain('web_search tool blocked');
      expect(result.citations).toEqual([]);
    });
  });

  describe('combined provider (Bing + Google News)', () => {
    const headline = (n: number) => ({
      title: `Headline ${n}`,
      url: `https://site${n}.example/article`,
      date: '2026-07-20',
      sourceName: `site${n}.example`,
    });
    const user = { email: 'test@example.com' } as any;

    beforeEach(() => {
      vi.mocked(fetchGoogleNewsHeadlines).mockClear();
    });

    it('fires interim headlines while Bing runs and merges both result sets', async () => {
      vi.mocked(fetchGoogleNewsHeadlines).mockResolvedValue([
        headline(1),
        headline(2),
      ]);
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockResolvedValue({
        text: 'Bing summary [1]',
        citations: [
          {
            number: 1,
            title: 'Deep article',
            url: 'https://deep.example',
            date: '2026-07-19',
          },
        ],
      });
      const onInterimResults = vi.fn();

      const result = await webSearchTool.execute({
        searchQuery: 'fusion energy milestone',
        provider: 'combined',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user,
        onInterimResults,
      });

      expect(onInterimResults).toHaveBeenCalledTimes(1);
      expect(onInterimResults).toHaveBeenCalledWith([headline(1), headline(2)]);
      expect(result.citations).toHaveLength(3);
      expect(result.citations![0].url).toBe('https://deep.example');
      // Headline numbering continues after the Bing citations.
      expect(result.citations![1].number).toBe(2);
      expect(result.citations![2].number).toBe(3);
      expect(result.text).toContain('Bing summary [1]');
      expect(result.text).toContain('Headline 1');
    });

    it('drops headlines whose URL Bing already cited', async () => {
      vi.mocked(fetchGoogleNewsHeadlines).mockResolvedValue([
        { ...headline(1), url: 'https://deep.example' },
        headline(2),
      ]);
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockResolvedValue({
        text: 'Bing summary',
        citations: [
          {
            number: 1,
            title: 'Deep article',
            url: 'https://deep.example',
            date: '2026-07-19',
          },
        ],
      });

      const result = await webSearchTool.execute({
        searchQuery: 'topic',
        provider: 'combined',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user,
      });

      expect(result.citations).toHaveLength(2);
      expect(
        result.citations!.filter((c) => c.url === 'https://deep.example'),
      ).toHaveLength(1);
    });

    it('returns the headlines alone when the Bing leg fails, flagged and with an honest note', async () => {
      vi.mocked(fetchGoogleNewsHeadlines).mockResolvedValue([headline(1)]);
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockRejectedValue(
        new Error('Foundry agent unavailable'),
      );

      const result = await webSearchTool.execute({
        searchQuery: 'topic',
        provider: 'combined',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user,
      });

      expect(result.citations).toHaveLength(1);
      expect(result.citations![0].url).toBe(headline(1).url);
      expect(result.text).toContain('Headline 1');
      // The model is told to level with the user about degraded coverage,
      // and the metadata flag lets the tool record say the same.
      expect(result.text).toContain('Bing) FAILED');
      expect(result.text).toContain('Google News headlines only');
      expect(result.metadata).toEqual({ bingFailed: true });
    });

    it('does not flag the result when both legs succeed', async () => {
      vi.mocked(fetchGoogleNewsHeadlines).mockResolvedValue([headline(1)]);
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockResolvedValue({
        text: 'Bing summary',
        citations: [
          { number: 1, title: 'A', url: 'https://a.example', date: '' },
        ],
      });

      const result = await webSearchTool.execute({
        searchQuery: 'topic',
        provider: 'combined',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user,
      });

      expect(result.metadata?.bingFailed).toBeUndefined();
    });

    it('returns the Bing result alone when the news leg fails', async () => {
      vi.mocked(fetchGoogleNewsHeadlines).mockRejectedValue(
        new Error('RSS unreachable'),
      );
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockResolvedValue({
        text: 'Bing only',
        citations: [
          { number: 1, title: 'A', url: 'https://a.example', date: '' },
        ],
      });
      const onInterimResults = vi.fn();

      const result = await webSearchTool.execute({
        searchQuery: 'topic',
        provider: 'combined',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user,
        onInterimResults,
      });

      expect(onInterimResults).not.toHaveBeenCalled();
      expect(result.text).toBe('Bing only');
      expect(result.citations).toHaveLength(1);
    });

    it('surfaces an error note when BOTH legs fail', async () => {
      vi.mocked(fetchGoogleNewsHeadlines).mockRejectedValue(
        new Error('RSS unreachable'),
      );
      vi.mocked(mockAgentChatService.executeWebSearchTool).mockRejectedValue(
        new Error('Foundry agent unavailable'),
      );

      const result = await webSearchTool.execute({
        searchQuery: 'topic',
        provider: 'combined',
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        user,
      });

      expect(result.citations).toEqual([]);
      expect(result.text).toContain('Web search encountered an issue');
      expect(result.text).toContain('Foundry agent unavailable');
    });

    it('degrades to the news feed (no interim emission) without an agent model', async () => {
      vi.mocked(fetchGoogleNewsHeadlines).mockResolvedValue([headline(1)]);
      const onInterimResults = vi.fn();

      const result = await webSearchTool.execute({
        searchQuery: 'topic',
        provider: 'combined',
        user,
        onInterimResults,
      });

      expect(mockAgentChatService.executeWebSearchTool).not.toHaveBeenCalled();
      expect(onInterimResults).not.toHaveBeenCalled();
      expect(result.citations).toHaveLength(1);
      expect(result.text).toContain('Headline 1');
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
