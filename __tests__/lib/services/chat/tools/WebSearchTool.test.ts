import { AgentChatService } from '@/lib/services/chat/AgentChatService';
import { WebSearchTool } from '@/lib/services/chat/tools/WebSearchTool';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('WebSearchTool', () => {
  let webSearchTool: WebSearchTool;
  let mockAgentChatService: AgentChatService;

  beforeEach(() => {
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
