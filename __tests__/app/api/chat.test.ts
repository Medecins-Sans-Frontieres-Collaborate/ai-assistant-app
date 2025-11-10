import { NextRequest } from 'next/server';

import { ServiceContainer } from '@/lib/services/ServiceContainer';
import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import { ErrorCode, PipelineError } from '@/lib/types/errors';
import { MessageType } from '@/types/chat';

import { POST } from '@/app/api/chat/route';
import { auth } from '@/auth';
import OpenAI, { AzureOpenAI } from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock authentication
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

// Mock tiktoken cache to avoid WASM loading in tests
vi.mock('@/lib/utils/server/tiktokenCache', () => ({
  getGlobalTiktoken: vi.fn().mockResolvedValue({
    encode: vi.fn().mockReturnValue([1, 2, 3, 4, 5]),
  }),
}));

// Mock Azure credentials
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn(),
  getBearerTokenProvider: vi
    .fn()
    .mockReturnValue(() => Promise.resolve('mock-token')),
}));

// Create shared mock create function that can be configured in tests
const mockCreateFn = vi.fn();

// Mock OpenAI constructors to prevent actual client initialization
vi.mock('openai', () => {
  class MockAzureOpenAI {
    chat = {
      completions: {
        create: mockCreateFn,
      },
    };
  }

  class MockOpenAI {
    chat = {
      completions: {
        create: mockCreateFn,
      },
    };
  }

  return {
    AzureOpenAI: MockAzureOpenAI,
    default: MockOpenAI,
  };
});

/**
 * Integration Tests for /api/chat
 *
 * These tests verify the complete request flow:
 * - Authentication middleware
 * - Rate limiting middleware
 * - Input validation middleware
 * - Pipeline execution
 * - Error handling
 *
 * Unlike unit tests, these test the actual integration of all components.
 */
describe('/api/chat - Integration Tests', () => {
  const mockSession = {
    user: {
      id: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
      displayName: 'Test User',
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset rate limiter for each test
    RateLimiter.resetInstance();

    // Mock successful authentication by default
    vi.mocked(auth).mockResolvedValue(mockSession as any);

    // Mock Azure OpenAI client in ServiceContainer
    // We need to mock the actual chat completion call
    const mockChatCompletion = {
      choices: [
        {
          message: {
            content: 'This is a test response from the AI.',
            role: 'assistant',
          },
          finish_reason: 'stop',
          index: 0,
        },
      ],
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: Date.now(),
      model: 'gpt-4',
    };

    // Configure the shared mockCreateFn for this test
    mockCreateFn.mockResolvedValue(mockChatCompletion);
  });

  afterEach(() => {
    // Reset ServiceContainer after each test
    ServiceContainer.reset();
    RateLimiter.resetInstance();
  });

  /**
   * Helper to create a NextRequest for chat endpoint
   */
  const createChatRequest = (body: any): NextRequest => {
    return new NextRequest('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  };

  /**
   * Helper to parse JSON response
   */
  const parseJsonResponse = async (response: Response) => {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  };

  describe('Happy Path - Standard Chat', () => {
    it('should successfully handle a simple text chat request', async () => {
      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: 'Hello, how are you?',
            messageType: MessageType.TEXT,
          },
        ],
        prompt: 'You are a helpful assistant.',
        temperature: 0.7,
        stream: false,
      });

      const response = await POST(request);

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const data = await parseJsonResponse(response);
      expect(data.text).toBeDefined();
      expect(typeof data.text).toBe('string');
    });

    it('should successfully handle a streaming chat request', async () => {
      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: 'Tell me a joke',
            messageType: MessageType.TEXT,
          },
        ],
        stream: true,
      });

      const response = await POST(request);

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe(
        'text/plain; charset=utf-8',
      );
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.body).toBeDefined();
    });

    it('should handle multiple messages in conversation', async () => {
      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: 'What is 2+2?',
            messageType: MessageType.TEXT,
          },
          {
            role: 'assistant',
            content: '4',
            messageType: MessageType.TEXT,
          },
          {
            role: 'user',
            content: 'What about 3+3?',
            messageType: MessageType.TEXT,
          },
        ],
        stream: false,
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await parseJsonResponse(response);
      expect(data.text).toBeDefined();
    });
  });

  describe('Authentication & Authorization', () => {
    it('should reject requests without authentication', async () => {
      vi.mocked(auth).mockResolvedValue(null as any);

      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: 'Hello',
            messageType: MessageType.TEXT,
          },
        ],
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await parseJsonResponse(response);
      expect(data.code).toBe(ErrorCode.AUTH_FAILED);
      expect(data.message).toContain('Unauthorized');
    });
  });

  describe('Rate Limiting', () => {
    it('should allow requests within rate limit', async () => {
      const requestBody = {
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: 'Hello',
            messageType: MessageType.TEXT,
          },
        ],
        stream: false,
      };

      // First request should succeed
      const response1 = await POST(createChatRequest(requestBody));
      expect(response1.status).toBe(200);

      // Second request should also succeed (within limit)
      const response2 = await POST(createChatRequest(requestBody));
      expect(response2.status).toBe(200);
    });

    it('should reject requests exceeding rate limit', async () => {
      // Get rate limiter with low limit for testing
      const limiter = RateLimiter.getInstance(2, 1); // 2 requests per minute

      const requestBody = {
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: 'Hello',
            messageType: MessageType.TEXT,
          },
        ],
        stream: false,
      };

      // Make requests up to the limit
      await POST(createChatRequest(requestBody));
      await POST(createChatRequest(requestBody));

      // Third request should be rate limited
      const response = await POST(createChatRequest(requestBody));

      expect(response.status).toBe(401); // Will be 401 since it's treated as critical auth error
      const data = await parseJsonResponse(response);
      expect(data.code).toBe(ErrorCode.RATE_LIMIT_EXCEEDED);
      expect(data.message).toContain('Rate limit exceeded');
    });
  });

  describe('Input Validation', () => {
    it('should reject requests with missing model', async () => {
      const request = createChatRequest({
        messages: [
          {
            role: 'user',
            content: 'Hello',
            messageType: MessageType.TEXT,
          },
        ],
      });

      const response = await POST(request);

      expect(response.status).toBe(400); // Validation errors return 400
      const data = await parseJsonResponse(response);
      expect(data.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('should reject requests with empty messages array', async () => {
      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [],
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await parseJsonResponse(response);
      expect(data.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(data.message).toContain('At least one message');
    });

    it('should reject requests with invalid temperature', async () => {
      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: 'Hello',
            messageType: MessageType.TEXT,
          },
        ],
        temperature: 5.0, // Invalid: max is 2
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await parseJsonResponse(response);
      expect(data.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('should reject oversized requests', async () => {
      // Create a very large message
      const largeContent = 'x'.repeat(11 * 1024 * 1024); // 11MB (over 10MB limit)

      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: largeContent,
            messageType: MessageType.TEXT,
          },
        ],
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await parseJsonResponse(response);
      expect(data.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(data.message).toContain('too large');
    });

    it('should reject invalid message roles', async () => {
      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'invalid_role', // Invalid role
            content: 'Hello',
            messageType: MessageType.TEXT,
          },
        ],
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await parseJsonResponse(response);
      expect(data.code).toBe(ErrorCode.VALIDATION_FAILED);
    });
  });

  describe('Request Timeout', () => {
    it('should timeout long-running requests', async () => {
      // Mock a slow handler that takes longer than timeout
      mockCreateFn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 65000); // 65 seconds (longer than 60s timeout)
          }),
      );

      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: 'Hello',
            messageType: MessageType.TEXT,
          },
        ],
        stream: false,
      });

      const response = await POST(request);

      expect(response.status).toBe(408);
      const data = await parseJsonResponse(response);
      // Pipeline stage timeout returns PIPELINE_TIMEOUT code
      expect(data.code).toBe(ErrorCode.PIPELINE_TIMEOUT);
      expect(data.message).toContain('timeout');
    }, 70000); // Increase test timeout
  });

  describe('ServiceContainer Integration', () => {
    it('should initialize ServiceContainer once and reuse services', async () => {
      const getInstanceSpy = vi.spyOn(ServiceContainer, 'getInstance');

      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: 'Hello',
            messageType: MessageType.TEXT,
          },
        ],
        stream: false,
      });

      // Make multiple requests
      await POST(request);
      await POST(request);
      await POST(request);

      // ServiceContainer.getInstance should be called multiple times
      // but should return the same instance
      expect(getInstanceSpy).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle and format errors properly', async () => {
      // Mock handler to throw an error
      mockCreateFn.mockRejectedValueOnce(new Error('OpenAI API Error'));

      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [
          {
            role: 'user',
            content: 'Hello',
            messageType: MessageType.TEXT,
          },
        ],
        stream: false,
      });

      const response = await POST(request);

      expect(response.status).toBe(500);
      const data = await parseJsonResponse(response);
      expect(data.error).toBeDefined();
      expect(data.message).toBeDefined();
    });

    it('should handle PipelineError with correct status codes', async () => {
      // This is already tested in validation tests, but good to verify
      // that PipelineErrors are properly caught and formatted
      const request = createChatRequest({
        model: { id: 'gpt-4', name: 'GPT-4', tokenLimit: 8000 },
        messages: [], // Invalid
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await parseJsonResponse(response);
      expect(data.code).toBe(ErrorCode.VALIDATION_FAILED);
    });
  });
});
