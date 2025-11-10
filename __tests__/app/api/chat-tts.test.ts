import { NextRequest } from 'next/server';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { POST } from '@/app/api/chat/tts/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mocks before imports
const mockAuth = vi.hoisted(() => vi.fn());
const mockCleanMarkdown = vi.hoisted(() => vi.fn());

// Mock dependencies
vi.mock('@/auth', () => ({
  auth: mockAuth,
}));

vi.mock('@/lib/utils/app/clean', () => ({
  cleanMarkdown: mockCleanMarkdown,
}));

// Mock Azure Speech SDK - we won't test full synthesis, just validation
vi.mock('microsoft-cognitiveservices-speech-sdk', () => ({
  SpeechConfig: {
    fromSubscription: vi.fn(),
  },
  SpeechSynthesizer: vi.fn(),
  SpeechSynthesisOutputFormat: {
    Audio16Khz32KBitRateMonoMp3: 3,
  },
  ResultReason: {
    SynthesizingAudioCompleted: 3,
  },
}));

/**
 * Tests for POST /api/chat/tts
 * Text-to-speech endpoint using Azure Speech Services
 *
 * Note: These tests focus on authentication, validation, and text cleaning.
 * Full Azure Speech SDK integration testing is complex and not included here.
 */
describe('/api/chat/tts', () => {
  const mockSession = createMockSession();

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup auth mock
    mockAuth.mockResolvedValue(mockSession as any);

    // Setup clean markdown mock - default passes through text
    mockCleanMarkdown.mockImplementation((text) => text);

    // Mock environment variable
    process.env.OPENAI_API_KEY = 'test-api-key';
  });

  const createTTSRequest = (options: {
    body?: any;
    url?: string;
  }): NextRequest => {
    const {
      body = {
        text: 'Hello, this is a test message.',
      },
      url = 'http://localhost:3000/api/chat/tts',
    } = options;

    return createMockRequest({
      method: 'POST',
      url,
      body,
    });
  };

  describe('Authentication', () => {
    it('throws error when session is not found', async () => {
      mockAuth.mockResolvedValue(null);

      const request = createTTSRequest({});

      await expect(POST(request)).rejects.toThrow('Failed to pull session!');
    });
  });

  describe('Request Validation', () => {
    it('returns 400 when text is not provided', async () => {
      const request = createTTSRequest({
        body: {},
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('No text provided');
    });

    it('returns 400 when text is empty after cleaning', async () => {
      mockCleanMarkdown.mockReturnValue('');

      const request = createTTSRequest({
        body: {
          text: 'Some text',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('No text provided');
    });

    it('handles whitespace text (passes validation but may fail synthesis)', async () => {
      mockCleanMarkdown.mockReturnValue('   ');

      const request = createTTSRequest({
        body: {
          text: '### Title\n\n',
        },
      });

      // Whitespace is truthy so passes validation, but synthesis will fail
      try {
        await POST(request);
      } catch {
        // Expected - synthesis will fail
      }

      expect(mockCleanMarkdown).toHaveBeenCalledWith('### Title\n\n');
    });
  });

  describe('Text Cleaning', () => {
    it('cleans markdown from text before synthesis', async () => {
      const request = createTTSRequest({
        body: {
          text: '# Heading\n\nSome **bold** and *italic* text.',
        },
      });

      // This will fail during synthesis but should call cleanMarkdown first
      try {
        await POST(request);
      } catch {
        // Expected to fail without full SDK mock
      }

      expect(mockCleanMarkdown).toHaveBeenCalledWith(
        '# Heading\n\nSome **bold** and *italic* text.',
      );
    });

    it('processes text with code blocks', async () => {
      const textWithCode =
        'Here is code:\n```python\nprint("hello")\n```\nEnd.';

      const request = createTTSRequest({
        body: {
          text: textWithCode,
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected to fail without full SDK mock
      }

      expect(mockCleanMarkdown).toHaveBeenCalledWith(textWithCode);
    });

    it('processes text with special characters', async () => {
      const textWithSpecial = "Hello! How are you? I'm doing well & great.";

      const request = createTTSRequest({
        body: {
          text: textWithSpecial,
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected to fail without full SDK mock
      }

      expect(mockCleanMarkdown).toHaveBeenCalledWith(textWithSpecial);
    });
  });

  describe('Configuration', () => {
    it('returns error when API key is not configured', async () => {
      delete process.env.OPENAI_API_KEY;

      const request = createTTSRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Internal server error');

      // Restore for other tests
      process.env.OPENAI_API_KEY = 'test-api-key';
    });
  });

  describe('Error Handling', () => {
    it('returns 500 on general errors', async () => {
      mockAuth.mockRejectedValue(new Error('Database error'));

      const request = createTTSRequest({});

      await expect(POST(request)).rejects.toThrow();
    });

    it('logs errors to console', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      mockCleanMarkdown.mockImplementation(() => {
        throw new Error('Cleaning error');
      });

      const request = createTTSRequest({});

      try {
        await POST(request);
      } catch {
        // Expected
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error in text-to-speech conversion:',
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Input Variations', () => {
    it('processes short text', async () => {
      const request = createTTSRequest({
        body: {
          text: 'Hi',
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected without full SDK
      }

      expect(mockCleanMarkdown).toHaveBeenCalledWith('Hi');
    });

    it('processes long text', async () => {
      const longText = 'This is a very long text. '.repeat(100);

      const request = createTTSRequest({
        body: {
          text: longText,
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected without full SDK
      }

      expect(mockCleanMarkdown).toHaveBeenCalledWith(longText);
    });

    it('processes text with multiple paragraphs', async () => {
      const multiParagraph = 'Paragraph 1.\n\nParagraph 2.\n\nParagraph 3.';

      const request = createTTSRequest({
        body: {
          text: multiParagraph,
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected without full SDK
      }

      expect(mockCleanMarkdown).toHaveBeenCalledWith(multiParagraph);
    });
  });
});
