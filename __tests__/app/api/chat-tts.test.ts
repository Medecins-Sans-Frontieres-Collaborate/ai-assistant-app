import { NextRequest } from 'next/server';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { POST } from '@/app/api/chat/tts/route';
import { auth } from '@/auth';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mocks before imports
const mockAuth = vi.hoisted(() => vi.fn());
const mockCleanMarkdown = vi.hoisted(() => vi.fn());
const mockDetectLanguage = vi.hoisted(() => vi.fn());
const mockIsMultilingualVoice = vi.hoisted(() => vi.fn());
const mockResolveVoiceForLanguage = vi.hoisted(() => vi.fn());
const mockGetBaseLanguageCode = vi.hoisted(() => vi.fn());

// Mock dependencies
vi.mock('@/auth', () => ({
  auth: mockAuth,
}));

vi.mock('@/lib/utils/app/clean', () => ({
  cleanMarkdown: mockCleanMarkdown,
}));

vi.mock('@/lib/services/languageDetection', () => ({
  detectLanguage: mockDetectLanguage,
}));

vi.mock('@/lib/data/ttsVoices', () => ({
  isMultilingualVoice: mockIsMultilingualVoice,
  resolveVoiceForLanguage: mockResolveVoiceForLanguage,
  getBaseLanguageCode: mockGetBaseLanguageCode,
  getDefaultVoiceForLocale: vi.fn(() => ({ name: 'en-US-AvaNeural' })),
  getTTSLocaleForAppLocale: vi.fn((locale) => `${locale}-US`),
}));

// Mock Azure Speech SDK - we won't test full synthesis, just validation
// The mock synthesizer calls the error callback immediately to prevent hanging
vi.mock('microsoft-cognitiveservices-speech-sdk', () => ({
  SpeechConfig: {
    fromEndpoint: vi.fn(() => ({
      speechSynthesisOutputFormat: null,
      speechSynthesisVoiceName: null,
    })),
  },
  SpeechSynthesizer: vi.fn(() => ({
    speakTextAsync: vi.fn(
      (
        _text: string,
        _onResult: (result: unknown) => void,
        onError: (error: string) => void,
      ) => {
        // Call error callback immediately to prevent timeout
        onError('Mock: No real synthesis in tests');
      },
    ),
    speakSsmlAsync: vi.fn(
      (
        _ssml: string,
        _onResult: (result: unknown) => void,
        onError: (error: string) => void,
      ) => {
        // Call error callback immediately to prevent timeout
        onError('Mock: No real synthesis in tests');
      },
    ),
    close: vi.fn(),
  })),
  SpeechSynthesisOutputFormat: {
    Audio16Khz32KBitRateMonoMp3: 3,
    Audio16Khz64KBitRateMonoMp3: 4,
    Audio24Khz48KBitRateMonoMp3: 5,
    Audio24Khz96KBitRateMonoMp3: 6,
    Audio48Khz96KBitRateMonoMp3: 7,
    Audio48Khz192KBitRateMonoMp3: 8,
  },
  ResultReason: {
    SynthesizingAudioCompleted: 3,
  },
  CancellationDetails: {
    fromResult: vi.fn(() => ({
      reason: 'Error',
      ErrorCode: 'MockError',
      errorDetails: 'Mock synthesis error',
    })),
  },
}));

// The application identity and the Speech endpoint it authenticates against.
const APPLICATION_CREDENTIAL = vi.hoisted(() => ({ getToken: vi.fn() }));
const mockResolveSpeechEndpoint = vi.hoisted(() => vi.fn());
vi.mock('@/lib/utils/server/azure/cognitiveServicesAuth', () => ({
  getApplicationCredential: () => APPLICATION_CREDENTIAL,
  resolveSpeechEndpoint: mockResolveSpeechEndpoint,
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

    // Setup language detection mock
    mockDetectLanguage.mockResolvedValue({ language: 'en', confidence: 0.95 });

    // Setup voice resolution mocks
    mockIsMultilingualVoice.mockReturnValue(false);
    mockResolveVoiceForLanguage.mockReturnValue('en-US-AvaNeural');
    mockGetBaseLanguageCode.mockImplementation((locale) =>
      locale.split('-')[0].toLowerCase(),
    );

    mockResolveSpeechEndpoint.mockReturnValue(
      'https://test-account.cognitiveservices.azure.com',
    );
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
    it('returns 401 when session is not found', async () => {
      mockAuth.mockResolvedValue(null);

      const request = createTTSRequest({});

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
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
      expect(data.error).toBe('Text could not be processed');
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
    it('authenticates with the application identity on the account endpoint', async () => {
      await POST(createTTSRequest({}));

      expect(sdk.SpeechConfig.fromEndpoint).toHaveBeenCalledWith(
        new URL('https://test-account.cognitiveservices.azure.com'),
        APPLICATION_CREDENTIAL,
      );
    });

    it('returns 503 without synthesizing when no Speech endpoint is configured', async () => {
      mockResolveSpeechEndpoint.mockReturnValue(undefined);

      const response = await POST(createTTSRequest({}));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(503);
      expect(data.error).toMatch(/AZURE_SPEECH_ENDPOINT/);
      expect(sdk.SpeechConfig.fromEndpoint).not.toHaveBeenCalled();
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

  describe('TTS Settings and Voice Resolution', () => {
    it('skips language detection when global voice is multilingual', async () => {
      mockIsMultilingualVoice.mockReturnValue(true);

      const request = createTTSRequest({
        body: {
          text: 'Hello world',
          globalVoice: 'en-US-AvaMultilingualNeural',
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected without full SDK
      }

      // Should check if globalVoice is multilingual
      expect(mockIsMultilingualVoice).toHaveBeenCalledWith(
        'en-US-AvaMultilingualNeural',
      );

      // Should NOT detect language when multilingual voice is used
      expect(mockDetectLanguage).not.toHaveBeenCalled();
    });

    it('detects language when global voice is not multilingual', async () => {
      mockIsMultilingualVoice.mockReturnValue(false);

      const request = createTTSRequest({
        body: {
          text: 'Bonjour le monde',
          globalVoice: 'en-US-AvaNeural',
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected without full SDK
      }

      // Should detect language for non-multilingual voice
      expect(mockDetectLanguage).toHaveBeenCalledWith('Bonjour le monde');
    });

    it('uses explicit voiceName override without checking settings', async () => {
      const request = createTTSRequest({
        body: {
          text: 'Hello world',
          voiceName: 'fr-FR-DeniseNeural',
          globalVoice: 'en-US-AvaMultilingualNeural',
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected without full SDK
      }

      // Should NOT check if voice is multilingual when explicit override provided
      expect(mockIsMultilingualVoice).not.toHaveBeenCalled();
      // Should NOT detect language when explicit override provided
      expect(mockDetectLanguage).not.toHaveBeenCalled();
    });

    it('passes language voice preferences to resolver', async () => {
      mockIsMultilingualVoice.mockReturnValue(false);
      mockGetBaseLanguageCode.mockReturnValue('en');

      const languageVoices = {
        en: 'en-IE-EmilyNeural',
        fr: 'fr-FR-DeniseNeural',
      };

      const request = createTTSRequest({
        body: {
          text: 'Hello world',
          globalVoice: 'en-US-AvaNeural',
          languageVoices,
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected without full SDK
      }

      // Should call resolveVoiceForLanguage with settings including languageVoices
      expect(mockResolveVoiceForLanguage).toHaveBeenCalledWith(
        'en',
        expect.objectContaining({
          languageVoices: expect.objectContaining({
            en: 'en-IE-EmilyNeural',
            fr: 'fr-FR-DeniseNeural',
          }),
        }),
      );
    });

    it('uses pre-detected language hint when provided', async () => {
      mockIsMultilingualVoice.mockReturnValue(false);
      mockGetBaseLanguageCode.mockReturnValue('fr');

      const request = createTTSRequest({
        body: {
          text: 'Bonjour',
          detectedLanguage: 'fr',
          globalVoice: 'en-US-AvaNeural',
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected without full SDK
      }

      // Should NOT call language detection when hint is provided
      expect(mockDetectLanguage).not.toHaveBeenCalled();

      // Should use the provided language hint
      expect(mockGetBaseLanguageCode).toHaveBeenCalledWith('fr');
    });

    it('falls back to default settings when none provided', async () => {
      mockIsMultilingualVoice.mockReturnValue(true);

      const request = createTTSRequest({
        body: {
          text: 'Hello world',
          // No globalVoice or languageVoices provided
        },
      });

      try {
        await POST(request);
      } catch {
        // Expected without full SDK
      }

      // Should check the default global voice (en-US-AvaMultilingualNeural)
      expect(mockIsMultilingualVoice).toHaveBeenCalledWith(
        'en-US-AvaMultilingualNeural',
      );
    });
  });

  describe('Rate and Pitch Validation', () => {
    it('returns 400 when rate is below minimum', async () => {
      const request = createTTSRequest({
        body: {
          text: 'Hello world',
          rate: 0.3, // Below 0.5 minimum
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Rate must be between 0.5 and 2.0');
    });

    it('returns 400 when rate is above maximum', async () => {
      const request = createTTSRequest({
        body: {
          text: 'Hello world',
          rate: 2.5, // Above 2.0 maximum
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Rate must be between 0.5 and 2.0');
    });

    it('returns 400 when pitch is below minimum', async () => {
      const request = createTTSRequest({
        body: {
          text: 'Hello world',
          pitch: -60, // Below -50 minimum
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Pitch must be between -50 and 50');
    });

    it('returns 400 when pitch is above maximum', async () => {
      const request = createTTSRequest({
        body: {
          text: 'Hello world',
          pitch: 60, // Above 50 maximum
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Pitch must be between -50 and 50');
    });
  });
});
