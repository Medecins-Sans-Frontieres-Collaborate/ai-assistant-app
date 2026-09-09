import { NextRequest } from 'next/server';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { POST } from '@/app/api/chat/summarize/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mocks before imports
const mockAuth = vi.hoisted(() => vi.fn());
const mockDefaultAzureCredential = vi.hoisted(() => vi.fn());
const mockGetBearerTokenProvider = vi.hoisted(() => vi.fn());
const mockAzureOpenAI = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());

// Mock dependencies
vi.mock('@/auth', () => ({
  auth: mockAuth,
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: mockDefaultAzureCredential,
  getBearerTokenProvider: mockGetBearerTokenProvider,
}));

vi.mock('openai', () => ({
  AzureOpenAI: mockAzureOpenAI,
}));

/**
 * Tests for POST /api/chat/summarize
 * Conversation compaction summary endpoint (best-effort, soft-fail).
 */
describe('/api/chat/summarize', () => {
  // Unique user per test so the route's module-level rate limiter (20/min)
  // never trips across the suite.
  let userCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAuth.mockResolvedValue(
      createMockSession(`summarize-user-${userCounter++}`) as any,
    );

    mockDefaultAzureCredential.mockImplementation(function (this: any) {
      return {};
    });
    mockGetBearerTokenProvider.mockReturnValue(vi.fn());

    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'The user discussed project planning.',
            }),
          },
        },
      ],
    });

    mockAzureOpenAI.mockImplementation(function (this: any) {
      return {
        chat: {
          completions: {
            create: mockCreate,
          },
        },
      };
    });
  });

  const createSummarizeRequest = (options: { body?: any }): NextRequest => {
    const {
      body = {
        messages: [
          { role: 'user', content: 'Tell me about our roadmap' },
          { role: 'assistant', content: 'The roadmap has three phases.' },
        ],
        modelId: 'gpt-5.2-chat',
      },
    } = options;

    return createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/chat/summarize',
      body,
    });
  };

  describe('Authentication', () => {
    it('returns 401 when session is not found', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await POST(createSummarizeRequest({}));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(401);
      expect(data.error).toBeDefined();
    });

    it('returns 401 when session has no user', async () => {
      mockAuth.mockResolvedValue({ user: null } as any);

      const response = await POST(createSummarizeRequest({}));

      expect(response.status).toBe(401);
    });
  });

  describe('Request Validation', () => {
    it('returns 400 when messages are missing', async () => {
      const response = await POST(
        createSummarizeRequest({ body: { modelId: 'gpt-5.2-chat' } }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBeDefined();
    });

    it('returns 400 when messages is an empty array', async () => {
      const response = await POST(
        createSummarizeRequest({ body: { messages: [] } }),
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when previousSummary is not a string', async () => {
      const response = await POST(
        createSummarizeRequest({
          body: {
            messages: [{ role: 'user', content: 'hi' }],
            previousSummary: 42,
          },
        }),
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when the request body exceeds the size limit', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const response = await POST(
        createSummarizeRequest({
          body: {
            messages: [{ role: 'user', content: 'x'.repeat(11 * 1024 * 1024) }],
          },
        }),
      );

      expect(response.status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });
  });

  describe('Success', () => {
    it('returns the generated summary', async () => {
      const response = await POST(createSummarizeRequest({}));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.summary).toBe('The user discussed project planning.');
    });

    it('uses strict json_schema structured output', async () => {
      await POST(createSummarizeRequest({}));

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: expect.objectContaining({
            type: 'json_schema',
            json_schema: expect.objectContaining({
              name: 'conversation_summary',
              strict: true,
            }),
          }),
        }),
      );
    });

    it('includes the previous summary in the model input when provided', async () => {
      await POST(
        createSummarizeRequest({
          body: {
            messages: [{ role: 'user', content: 'more details please' }],
            previousSummary: 'Earlier: the user planned a trip.',
          },
        }),
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining(
                'Earlier: the user planned a trip.',
              ),
            }),
          ]),
        }),
      );
    });

    it('falls back to gpt-5.4 for byom- model ids', async () => {
      await POST(
        createSummarizeRequest({
          body: {
            messages: [{ role: 'user', content: 'hi' }],
            modelId: 'byom-abc123-my-gpt',
          },
        }),
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.4' }),
      );
    });

    it('falls back to gpt-5.4 for agent-prefixed model ids', async () => {
      await POST(
        createSummarizeRequest({
          body: {
            messages: [{ role: 'user', content: 'hi' }],
            modelId: 'foundry-some-agent',
          },
        }),
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.4' }),
      );
    });

    it('falls back to gpt-5.4 when no modelId is provided', async () => {
      await POST(
        createSummarizeRequest({
          body: { messages: [{ role: 'user', content: 'hi' }] },
        }),
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.4' }),
      );
    });

    it('falls back to gpt-5.4 for anthropic-foundry model ids', async () => {
      await POST(
        createSummarizeRequest({
          body: {
            messages: [{ role: 'user', content: 'hi' }],
            modelId: 'claude-sonnet-4-6',
          },
        }),
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.4' }),
      );
    });

    it('falls back to gpt-5.4 for Foundry openai-sdk model ids', async () => {
      await POST(
        createSummarizeRequest({
          body: {
            messages: [{ role: 'user', content: 'hi' }],
            modelId: 'Mistral-Large-3',
          },
        }),
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.4' }),
      );
    });

    it('falls back to gpt-5.4 for unknown model ids', async () => {
      await POST(
        createSummarizeRequest({
          body: {
            messages: [{ role: 'user', content: 'hi' }],
            modelId: 'totally-unknown-model',
          },
        }),
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.4' }),
      );
    });
  });

  describe('Soft-fail behavior', () => {
    it('returns 200 { summary: null } when the model call throws', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      mockCreate.mockRejectedValue(new Error('API error'));

      const response = await POST(createSummarizeRequest({}));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.summary).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('returns 200 { summary: null } when the model returns no content', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null } }],
      });

      const response = await POST(createSummarizeRequest({}));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.summary).toBeNull();
    });

    it('returns 200 { summary: null } when the model returns invalid JSON', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'not json' } }],
      });

      const response = await POST(createSummarizeRequest({}));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.summary).toBeNull();

      consoleErrorSpy.mockRestore();
    });
  });
});
