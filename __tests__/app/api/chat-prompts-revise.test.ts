import { NextRequest } from 'next/server';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { POST } from '@/app/api/chat/prompts/revise/route';
import { auth } from '@/auth';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import { AzureOpenAI } from 'openai';
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
 * Tests for POST /api/chat/prompts/revise
 * Prompt revision and generation endpoint
 */
describe('/api/chat/prompts/revise', () => {
  const mockSession = createMockSession();

  const mockRevisionResponse = {
    revisedPrompt: 'Improved prompt content',
    improvements: [
      {
        category: 'Clarity',
        description: 'Made instructions more specific',
      },
      {
        category: 'Structure',
        description: 'Added logical flow',
      },
    ],
    suggestions: ['Use variables for dynamic content', 'Test with real data'],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup auth mock
    mockAuth.mockResolvedValue(mockSession as any);

    // Setup Azure Identity mocks
    mockDefaultAzureCredential.mockImplementation(function (this: any) {
      return {};
    });
    mockGetBearerTokenProvider.mockReturnValue(vi.fn());

    // Setup Azure OpenAI client mock
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify(mockRevisionResponse),
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

  const createReviseRequest = (options: {
    body?: any;
    url?: string;
  }): NextRequest => {
    const {
      body = {
        promptName: 'Test Prompt',
        promptContent: 'Write a summary',
        revisionGoal: 'Make it more specific',
      },
      url = 'http://localhost:3000/api/chat/prompts/revise',
    } = options;

    return createMockRequest({
      method: 'POST',
      url,
      body,
    });
  };

  describe('Authentication', () => {
    it('returns 401 when session is not found', async () => {
      mockAuth.mockResolvedValue(null);

      const request = createReviseRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(401);
      expect(data.error).toBeDefined();
    });

    it('returns 401 when session has no user', async () => {
      mockAuth.mockResolvedValue({ user: null } as any);

      const request = createReviseRequest({});
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('allows authenticated requests', async () => {
      const request = createReviseRequest({});
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe('Request Validation - Revision Mode', () => {
    it('returns 400 when promptContent is missing', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Test',
          generateNew: false,
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toContain('Prompt content is required');
    });

    it('returns 400 when promptContent is empty', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Test',
          promptContent: '',
          generateNew: false,
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toContain('Prompt content is required');
    });

    it('returns 400 when promptContent is only whitespace', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Test',
          promptContent: '   ',
          generateNew: false,
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toContain('Prompt content is required');
    });

    it('accepts valid revision request', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Summary Prompt',
          promptContent: 'Write a summary of the text',
          revisionGoal: 'Add more structure',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe('Request Validation - Generation Mode', () => {
    it('returns 400 when neither revisionGoal nor promptDescription provided', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'New Prompt',
          generateNew: true,
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toContain('Description or goal is required');
    });

    it('accepts generation request with revisionGoal', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'New Prompt',
          generateNew: true,
          revisionGoal: 'Create a prompt for code review',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('accepts generation request with promptDescription', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'New Prompt',
          generateNew: true,
          promptDescription: 'A prompt for analyzing code quality',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe('Prompt Revision', () => {
    it('sends correct system prompt for revision mode', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Test',
          promptContent: 'Original prompt',
          generateNew: false,
        },
      });

      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining(
                'expert at crafting effective AI prompts',
              ),
            }),
          ]),
        }),
      );
    });

    it('includes prompt content in user message', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Test Prompt',
          promptContent: 'Original content here',
          revisionGoal: 'Make it better',
        },
      });

      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining('Original content here'),
            }),
          ]),
        }),
      );
    });

    it('includes revision goal when provided', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Test',
          promptContent: 'Content',
          revisionGoal: 'Add examples',
        },
      });

      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining('Add examples'),
            }),
          ]),
        }),
      );
    });

    it('includes additional context when provided', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Test',
          promptContent: 'Content',
          additionalContext: 'File context data',
        },
      });

      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining('File context data'),
            }),
          ]),
        }),
      );
    });
  });

  describe('Prompt Generation', () => {
    it('sends correct system prompt for generation mode', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'New Prompt',
          generateNew: true,
          revisionGoal: 'Create from scratch',
        },
      });

      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('create prompts from scratch'),
            }),
          ]),
        }),
      );
    });

    it('includes requirements in user message', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Code Review',
          generateNew: true,
          revisionGoal: 'Analyze code for bugs',
        },
      });

      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining('Analyze code for bugs'),
            }),
          ]),
        }),
      );
    });
  });

  describe('Azure OpenAI Integration', () => {
    it('creates Azure OpenAI client with correct config', async () => {
      const request = createReviseRequest({});
      await POST(request);

      expect(DefaultAzureCredential).toHaveBeenCalled();
      expect(getBearerTokenProvider).toHaveBeenCalled();
      expect(AzureOpenAI).toHaveBeenCalled();
    });

    it('uses max_completion_tokens for GPT-5 reasoning model', async () => {
      const request = createReviseRequest({});
      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          max_completion_tokens: expect.any(Number),
        }),
      );

      // Ensure it does NOT use max_tokens (which is invalid for reasoning models)
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.max_tokens).toBeUndefined();
    });

    it('uses correct model (gpt-5.2)', async () => {
      const request = createReviseRequest({});
      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.2',
        }),
      );
    });

    it('does not set temperature', async () => {
      const request = createReviseRequest({});
      await POST(request);

      // Route does not set temperature — only max_completion_tokens is configured
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBeUndefined();
    });

    it('uses structured output with JSON schema', async () => {
      const request = createReviseRequest({});
      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: expect.objectContaining({
            type: 'json_schema',
            json_schema: expect.objectContaining({
              name: 'prompt_revision',
              strict: true,
            }),
          }),
        }),
      );
    });

    it('specifies required fields in schema', async () => {
      const request = createReviseRequest({});
      await POST(request);

      const callArgs = mockCreate.mock.calls[0][0];
      const schema = callArgs.response_format.json_schema.schema;

      expect(schema.required).toEqual([
        'revisedPrompt',
        'improvements',
        'suggestions',
      ]);
    });
  });

  describe('Response Handling', () => {
    it('returns revised prompt', async () => {
      const request = createReviseRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.revisedPrompt).toBe('Improved prompt content');
    });

    it('returns improvements array', async () => {
      const request = createReviseRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(data.improvements).toHaveLength(2);
      expect(data.improvements[0]).toEqual({
        category: 'Clarity',
        description: 'Made instructions more specific',
      });
    });

    it('returns suggestions array', async () => {
      const request = createReviseRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(data.suggestions).toHaveLength(2);
      expect(data.suggestions[0]).toBe('Use variables for dynamic content');
    });
  });

  describe('Error Handling', () => {
    it('returns 500 when AI returns no content', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: null,
            },
          },
        ],
      });

      const request = createReviseRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBeDefined();
    });

    it('returns 500 when response has no choices', async () => {
      mockCreate.mockResolvedValue({
        choices: [],
      });

      const request = createReviseRequest({});
      const response = await POST(request);

      expect(response.status).toBe(500);
    });

    it('returns 500 when AI response is invalid JSON', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Invalid JSON',
            },
          },
        ],
      });

      const request = createReviseRequest({});
      const response = await POST(request);

      expect(response.status).toBe(500);
    });

    it('returns 500 when revisedPrompt is missing from response', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                improvements: [],
                suggestions: [],
              }),
            },
          },
        ],
      });

      const request = createReviseRequest({});
      const response = await POST(request);

      expect(response.status).toBe(500);
    });

    it('logs errors to console', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      mockCreate.mockRejectedValue(new Error('API error'));

      const request = createReviseRequest({});
      await POST(request);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Prompt Revision API] Error:',
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Integration Scenarios', () => {
    it('handles complete revision request', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Summary Generator',
          promptDescription: 'Generates summaries of articles',
          promptContent: 'Summarize the following text',
          revisionGoal: 'Add structure and examples',
          additionalContext: 'Context from files',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.revisedPrompt).toBeDefined();
      expect(data.improvements).toBeDefined();
      expect(data.suggestions).toBeDefined();
    });

    it('handles complete generation request', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Code Analyzer',
          promptDescription: 'Analyzes code for issues',
          generateNew: true,
          revisionGoal: 'Create a comprehensive code analysis prompt',
          additionalContext: 'Project structure info',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('handles minimal revision request', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'Simple Prompt',
          promptContent: 'Do something',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('handles minimal generation request', async () => {
      const request = createReviseRequest({
        body: {
          promptName: 'New',
          generateNew: true,
          promptDescription: 'A prompt',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });
});
