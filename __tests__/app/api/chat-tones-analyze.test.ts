import { NextRequest } from 'next/server';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { POST } from '@/app/api/chat/tones/analyze/route';
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

// Mock file handling dependencies (not tested in depth here)
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(),
}));

vi.mock('@/lib/services/transcriptionService', () => ({
  TranscriptionServiceFactory: {
    getTranscriptionService: vi.fn(),
  },
}));

vi.mock('@/lib/utils/server/file/fileHandling', () => ({
  loadDocument: vi.fn(),
}));

/**
 * Tests for POST /api/chat/tones/analyze
 * Tone analysis and voice profiling endpoint
 *
 * Note: File processing (blob storage, transcription) not deeply tested here.
 */
describe('/api/chat/tones/analyze', () => {
  const mockSession = createMockSession();

  const mockAnalysisResponse = {
    voiceRules:
      '- **Tone**: Professional and technical\n- **Vocabulary**: Prefers concrete terms\n- **Sentence Structure**: Short, active voice',
    examples:
      '1. Use active voice for clarity.\n2. Keep sentences concise.\n3. Avoid jargon when possible.',
    suggestedTags: ['professional', 'concise', 'technical'],
    characteristics: [
      {
        category: 'Formality',
        description: 'Uses formal language with technical precision',
      },
      {
        category: 'Structure',
        description: 'Prefers short sentences averaging 15 words',
      },
    ],
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
            content: JSON.stringify(mockAnalysisResponse),
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

  const createAnalyzeRequest = (options: {
    body?: any;
    url?: string;
  }): NextRequest => {
    const {
      body = {
        toneName: 'Professional Technical',
        sampleContent:
          'This document outlines our technical approach. We use modern frameworks.',
      },
      url = 'http://localhost:3000/api/chat/tones/analyze',
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

      const request = createAnalyzeRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(401);
      expect(data.error).toBeDefined();
    });

    it('returns 401 when session has no user', async () => {
      mockAuth.mockResolvedValue({ user: null } as any);

      const request = createAnalyzeRequest({});
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('allows authenticated requests', async () => {
      const request = createAnalyzeRequest({});
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe('Request Validation', () => {
    it('returns 400 when sampleContent is missing', async () => {
      const request = createAnalyzeRequest({
        body: {
          toneName: 'Test Tone',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toContain('Sample content is required');
    });

    it('returns 400 when sampleContent is empty', async () => {
      const request = createAnalyzeRequest({
        body: {
          toneName: 'Test Tone',
          sampleContent: '',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toContain('Sample content is required');
    });

    it('returns 400 when sampleContent is only whitespace', async () => {
      const request = createAnalyzeRequest({
        body: {
          toneName: 'Test Tone',
          sampleContent: '   \n   ',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toContain('Sample content is required');
    });

    it('accepts valid analysis request', async () => {
      const request = createAnalyzeRequest({
        body: {
          toneName: 'Casual Conversational',
          sampleContent: "Hey there! Let's talk about this topic.",
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe('Tone Analysis', () => {
    it('includes tone name in user message', async () => {
      const request = createAnalyzeRequest({
        body: {
          toneName: 'Academic Style',
          sampleContent: 'Sample content for analysis',
        },
      });

      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining('Academic Style'),
            }),
          ]),
        }),
      );
    });

    it('includes tone description when provided', async () => {
      const request = createAnalyzeRequest({
        body: {
          toneName: 'Tech Writer',
          toneDescription: 'Technical documentation style',
          sampleContent: 'Content here',
        },
      });

      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining('Technical documentation style'),
            }),
          ]),
        }),
      );
    });

    it('includes analysis goal when provided', async () => {
      const request = createAnalyzeRequest({
        body: {
          toneName: 'Style Guide',
          sampleContent: 'Content',
          analysisGoal: 'Extract formal writing patterns',
        },
      });

      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining(
                'Extract formal writing patterns',
              ),
            }),
          ]),
        }),
      );
    });

    it('includes sample content in message', async () => {
      const sampleText =
        'This is unique sample content for testing tone analysis.';

      const request = createAnalyzeRequest({
        body: {
          toneName: 'Test',
          sampleContent: sampleText,
        },
      });

      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining(sampleText),
            }),
          ]),
        }),
      );
    });
  });

  describe('Azure OpenAI Integration', () => {
    it('creates Azure OpenAI client with correct config', async () => {
      const request = createAnalyzeRequest({});
      await POST(request);

      expect(DefaultAzureCredential).toHaveBeenCalled();
      expect(getBearerTokenProvider).toHaveBeenCalled();
      expect(AzureOpenAI).toHaveBeenCalled();
    });

    it('uses max_completion_tokens for GPT-5 reasoning model', async () => {
      const request = createAnalyzeRequest({});
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
      const request = createAnalyzeRequest({});
      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.2',
        }),
      );
    });

    it('does not set temperature', async () => {
      const request = createAnalyzeRequest({});
      await POST(request);

      // Route does not set temperature — only max_completion_tokens is configured
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBeUndefined();
    });

    it('uses structured output with JSON schema', async () => {
      const request = createAnalyzeRequest({});
      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: expect.objectContaining({
            type: 'json_schema',
            json_schema: expect.objectContaining({
              name: 'tone_analysis',
              strict: true,
            }),
          }),
        }),
      );
    });

    it('specifies required fields in schema', async () => {
      const request = createAnalyzeRequest({});
      await POST(request);

      const callArgs = mockCreate.mock.calls[0][0];
      const schema = callArgs.response_format.json_schema.schema;

      expect(schema.required).toEqual([
        'voiceRules',
        'examples',
        'suggestedTags',
        'characteristics',
      ]);
    });

    it('sends tone analysis system prompt', async () => {
      const request = createAnalyzeRequest({});
      await POST(request);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('expert linguist'),
            }),
          ]),
        }),
      );
    });
  });

  describe('Response Handling', () => {
    it('returns voice rules', async () => {
      const request = createAnalyzeRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.voiceRules).toContain('Professional and technical');
    });

    it('returns examples', async () => {
      const request = createAnalyzeRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(data.examples).toContain('Use active voice');
    });

    it('returns suggested tags', async () => {
      const request = createAnalyzeRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(data.suggestedTags).toEqual([
        'professional',
        'concise',
        'technical',
      ]);
    });

    it('returns characteristics array', async () => {
      const request = createAnalyzeRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(data.characteristics).toHaveLength(2);
      expect(data.characteristics[0]).toEqual({
        category: 'Formality',
        description: 'Uses formal language with technical precision',
      });
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

      const request = createAnalyzeRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBeDefined();
    });

    it('returns 500 when response has no choices', async () => {
      mockCreate.mockResolvedValue({
        choices: [],
      });

      const request = createAnalyzeRequest({});
      const response = await POST(request);

      expect(response.status).toBe(500);
    });

    it('returns 500 when AI response is invalid JSON', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Not valid JSON',
            },
          },
        ],
      });

      const request = createAnalyzeRequest({});
      const response = await POST(request);

      expect(response.status).toBe(500);
    });

    it('returns 500 when voiceRules is missing from response', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                examples: 'Some examples',
                suggestedTags: [],
                characteristics: [],
              }),
            },
          },
        ],
      });

      const request = createAnalyzeRequest({});
      const response = await POST(request);

      expect(response.status).toBe(500);
    });

    it('logs errors to console', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      mockCreate.mockRejectedValue(new Error('API error'));

      const request = createAnalyzeRequest({});
      await POST(request);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Tone Analysis API] Error:',
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Integration Scenarios', () => {
    it('handles complete analysis request with all fields', async () => {
      const request = createAnalyzeRequest({
        body: {
          toneName: 'Marketing Copy',
          toneDescription: 'Engaging and persuasive product descriptions',
          sampleContent:
            'Discover the power of our revolutionary platform. Transform your workflow today.',
          analysisGoal: 'Identify persuasive techniques and vocabulary choices',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.voiceRules).toBeDefined();
      expect(data.examples).toBeDefined();
      expect(data.suggestedTags).toBeDefined();
      expect(data.characteristics).toBeDefined();
    });

    it('handles minimal request with only required fields', async () => {
      const request = createAnalyzeRequest({
        body: {
          toneName: 'Simple',
          sampleContent: 'Short sample.',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('handles long sample content', async () => {
      const longContent = 'Sample paragraph. '.repeat(100);

      const request = createAnalyzeRequest({
        body: {
          toneName: 'Verbose Style',
          sampleContent: longContent,
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('handles multiple characteristic categories', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                voiceRules: 'Rules here',
                examples: 'Examples here',
                suggestedTags: ['tag1', 'tag2'],
                characteristics: [
                  { category: 'Formality', description: 'Formal' },
                  { category: 'Vocabulary', description: 'Technical terms' },
                  { category: 'Structure', description: 'Complex sentences' },
                  { category: 'Grammar', description: 'Strict punctuation' },
                  { category: 'Personality', description: 'Authoritative' },
                ],
              }),
            },
          },
        ],
      });

      const request = createAnalyzeRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(data.characteristics).toHaveLength(5);
    });
  });
});
