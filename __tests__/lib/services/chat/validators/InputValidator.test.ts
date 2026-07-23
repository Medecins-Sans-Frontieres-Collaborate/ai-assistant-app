import { Session } from 'next-auth';

import { InputValidator } from '@/lib/services/chat/validators/InputValidator';

import { VALIDATION_LIMITS } from '@/lib/utils/app/const';

import { ErrorCode, PipelineError } from '@/types/errors';
import { InterpreterMode } from '@/types/interpreterMode';

import { describe, expect, it } from 'vitest';

describe('InputValidator', () => {
  describe('validateFileSize', () => {
    const mockUser: Session['user'] = {
      id: 'test-user-123',
      mail: 'test@example.com',
      displayName: 'Test User',
      region: 'US',
    };

    it('should pass validation for files within size limit', async () => {
      const validator = new InputValidator();
      const mockGetFileSize = async () => 50 * 1024 * 1024; // 50MB

      await expect(
        validator.validateFileSize(
          'https://blob.azure.com/file.pdf',
          mockUser,
          mockGetFileSize,
          100 * 1024 * 1024, // 100MB limit
        ),
      ).resolves.not.toThrow();
    });

    it('should reject files exceeding size limit', async () => {
      const validator = new InputValidator();
      const mockGetFileSize = async () => 150 * 1024 * 1024; // 150MB

      await expect(
        validator.validateFileSize(
          'https://blob.azure.com/file.pdf',
          mockUser,
          mockGetFileSize,
          100 * 1024 * 1024, // 100MB limit
        ),
      ).rejects.toThrow(PipelineError);
    });

    it('should throw PipelineError with VALIDATION_FAILED code for oversized files', async () => {
      const validator = new InputValidator();
      const mockGetFileSize = async () => 150 * 1024 * 1024; // 150MB

      try {
        await validator.validateFileSize(
          'https://blob.azure.com/file.pdf',
          mockUser,
          mockGetFileSize,
          100 * 1024 * 1024,
        );
        expect.fail('Should have thrown PipelineError');
      } catch (error) {
        expect(error).toBeInstanceOf(PipelineError);
        expect((error as PipelineError).code).toBe(ErrorCode.VALIDATION_FAILED);
        expect((error as PipelineError).message).toContain('150.00MB');
        expect((error as PipelineError).message).toContain('100.00MB');
      }
    });

    it('should use default limit from VALIDATION_LIMITS when not specified', async () => {
      const validator = new InputValidator();
      // File size exceeds the default limit (FILE_DOWNLOAD_MAX_BYTES = 1.5GB)
      const fileOverLimit =
        VALIDATION_LIMITS.FILE_DOWNLOAD_MAX_BYTES + 1024 * 1024; // 1MB over
      const mockGetFileSize = async () => fileOverLimit;

      await expect(
        validator.validateFileSize(
          'https://blob.azure.com/file.pdf',
          mockUser,
          mockGetFileSize,
        ),
      ).rejects.toThrow(PipelineError);
    });

    it('should accept files exactly at the size limit', async () => {
      const validator = new InputValidator();
      const maxSize = 100 * 1024 * 1024;
      const mockGetFileSize = async () => maxSize; // Exactly 100MB

      await expect(
        validator.validateFileSize(
          'https://blob.azure.com/file.pdf',
          mockUser,
          mockGetFileSize,
          maxSize,
        ),
      ).resolves.not.toThrow();
    });

    it('should reject files just over the size limit', async () => {
      const validator = new InputValidator();
      const maxSize = 100 * 1024 * 1024;
      const mockGetFileSize = async () => maxSize + 1; // 1 byte over

      await expect(
        validator.validateFileSize(
          'https://blob.azure.com/file.pdf',
          mockUser,
          mockGetFileSize,
          maxSize,
        ),
      ).rejects.toThrow(PipelineError);
    });

    it('should handle errors from getFileSize function', async () => {
      const validator = new InputValidator();
      const mockGetFileSize = async () => {
        throw new Error('Network error');
      };

      try {
        await validator.validateFileSize(
          'https://blob.azure.com/file.pdf',
          mockUser,
          mockGetFileSize,
        );
        expect.fail('Should have thrown PipelineError');
      } catch (error) {
        expect(error).toBeInstanceOf(PipelineError);
        expect((error as PipelineError).code).toBe(ErrorCode.VALIDATION_FAILED);
        expect((error as PipelineError).message).toContain(
          'Failed to validate file size',
        );
      }
    });

    it('should include file URL in error metadata', async () => {
      const validator = new InputValidator();
      const fileUrl = 'https://blob.azure.com/large-file.pdf';
      const mockGetFileSize = async () => 150 * 1024 * 1024;

      try {
        await validator.validateFileSize(
          fileUrl,
          mockUser,
          mockGetFileSize,
          100 * 1024 * 1024,
        );
        expect.fail('Should have thrown PipelineError');
      } catch (error) {
        expect(error).toBeInstanceOf(PipelineError);
        const pipelineError = error as PipelineError;
        expect(pipelineError.metadata?.fileUrl).toBe(fileUrl);
        expect(pipelineError.metadata?.fileSize).toBe(150 * 1024 * 1024);
        expect(pipelineError.metadata?.maxSize).toBe(100 * 1024 * 1024);
      }
    });

    it('should accept very small files (1KB)', async () => {
      const validator = new InputValidator();
      const mockGetFileSize = async () => 1024; // 1KB

      await expect(
        validator.validateFileSize(
          'https://blob.azure.com/small.txt',
          mockUser,
          mockGetFileSize,
          100 * 1024 * 1024,
        ),
      ).resolves.not.toThrow();
    });

    it('should accept 0-byte files', async () => {
      const validator = new InputValidator();
      const mockGetFileSize = async () => 0; // Empty file

      await expect(
        validator.validateFileSize(
          'https://blob.azure.com/empty.txt',
          mockUser,
          mockGetFileSize,
          100 * 1024 * 1024,
        ),
      ).resolves.not.toThrow();
    });
  });

  describe('validateChatRequest - file_url metadata', () => {
    const baseModel = { id: 'gpt-5', name: 'gpt-5' };
    const requestWith = (fileBlock: unknown) => ({
      model: baseModel,
      messages: [
        {
          role: 'user' as const,
          content: [fileBlock],
        },
      ],
    });

    it('preserves originalFilename, transcriptionLanguage, transcriptionPrompt through validation', () => {
      const validator = new InputValidator();
      const result = validator.validateChatRequest(
        requestWith({
          type: 'file_url',
          url: 'https://blob.core.windows.net/container/f.xlsx',
          originalFilename: 'Q1 Report.xlsx',
          transcriptionLanguage: 'es',
          transcriptionPrompt: 'Medical terminology',
        }),
      );
      const block = (result.messages[0].content as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(block.originalFilename).toBe('Q1 Report.xlsx');
      expect(block.transcriptionLanguage).toBe('es');
      expect(block.transcriptionPrompt).toBe('Medical terminology');
    });

    it('accepts file_url without any optional metadata', () => {
      const validator = new InputValidator();
      expect(() =>
        validator.validateChatRequest(
          requestWith({
            type: 'file_url',
            url: 'https://blob.core.windows.net/container/f.xlsx',
          }),
        ),
      ).not.toThrow();
    });

    it('drops filenames containing path separators but keeps the request valid', () => {
      const validator = new InputValidator();
      const result = validator.validateChatRequest(
        requestWith({
          type: 'file_url',
          url: 'https://blob.core.windows.net/container/f.xlsx',
          originalFilename: '../etc/passwd',
        }),
      );
      const block = (result.messages[0].content as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(block.originalFilename).toBeUndefined();
      expect(block.url).toBe('https://blob.core.windows.net/container/f.xlsx');
    });

    it('drops bare ".." filenames but keeps the request valid', () => {
      const validator = new InputValidator();
      const result = validator.validateChatRequest(
        requestWith({
          type: 'file_url',
          url: 'https://blob.core.windows.net/container/f.xlsx',
          originalFilename: '..',
        }),
      );
      const block = (result.messages[0].content as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(block.originalFilename).toBeUndefined();
    });

    it('accepts legitimate filenames containing dots (e.g. "archive.tar.gz")', () => {
      const validator = new InputValidator();
      const result = validator.validateChatRequest(
        requestWith({
          type: 'file_url',
          url: 'https://blob.core.windows.net/container/f.xlsx',
          originalFilename: 'archive.tar.gz',
        }),
      );
      const block = (result.messages[0].content as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(block.originalFilename).toBe('archive.tar.gz');
    });

    it('drops invalid transcription language codes instead of rejecting the request', () => {
      const validator = new InputValidator();
      const result = validator.validateChatRequest(
        requestWith({
          type: 'file_url',
          url: 'https://blob.core.windows.net/container/f.xlsx',
          transcriptionLanguage: 'english',
        }),
      );
      const block = (result.messages[0].content as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(block.transcriptionLanguage).toBeUndefined();
    });

    it('accepts ISO-639-1 codes with optional region and normalizes case', () => {
      const validator = new InputValidator();
      const result = validator.validateChatRequest(
        requestWith({
          type: 'file_url',
          url: 'https://blob.core.windows.net/container/f.xlsx',
          transcriptionLanguage: 'PT-BR',
        }),
      );
      const block = (result.messages[0].content as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(block.transcriptionLanguage).toBe('pt-br');
    });

    it('drops transcription prompts over 2000 chars rather than rejecting', () => {
      const validator = new InputValidator();
      const result = validator.validateChatRequest(
        requestWith({
          type: 'file_url',
          url: 'https://blob.core.windows.net/container/f.xlsx',
          transcriptionPrompt: 'x'.repeat(2001),
        }),
      );
      const block = (result.messages[0].content as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(block.transcriptionPrompt).toBeUndefined();
    });
  });
});

describe('validateChatRequest - custom-source (byom) trust boundary', () => {
  const ACCOUNT_PATH =
    '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-own-foundry';
  const base = {
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('strips client-supplied routing fields from the model object', () => {
    const validator = new InputValidator();
    const result = validator.validateChatRequest({
      ...base,
      model: {
        id: 'byom-abc123-my-gpt',
        name: 'my-gpt',
        modelSource: ACCOUNT_PATH,
        isCustomSourceModel: true,
        foundryEndpoint: 'https://evil.example',
        sdk: 'azure-openai',
      },
    });

    // Only the credential middleware may set these — anything the client
    // sends must die at the schema boundary.
    expect(result.model.id).toBe('byom-abc123-my-gpt');
    for (const field of [
      'modelSource',
      'isCustomSourceModel',
      'foundryEndpoint',
      'sdk',
    ]) {
      expect(result.model).not.toHaveProperty(field);
    }
  });

  it('accepts a modelSourcePath within the length cap', () => {
    const validator = new InputValidator();
    const result = validator.validateChatRequest({
      ...base,
      model: { id: 'byom-abc123-my-gpt', name: 'my-gpt' },
      modelSourcePath: ACCOUNT_PATH,
    });
    expect(result.modelSourcePath).toBe(ACCOUNT_PATH);
  });

  it('leaves modelSourcePath undefined when absent', () => {
    const validator = new InputValidator();
    const result = validator.validateChatRequest({
      ...base,
      model: { id: 'gpt-5.2', name: 'GPT-5.2' },
    });
    expect(result.modelSourcePath).toBeUndefined();
  });

  it('rejects a modelSourcePath over 512 chars', () => {
    const validator = new InputValidator();
    try {
      validator.validateChatRequest({
        ...base,
        model: { id: 'byom-abc123-my-gpt', name: 'my-gpt' },
        modelSourcePath: `/subscriptions/${'x'.repeat(512)}`,
      });
      expect.fail('Should have thrown PipelineError');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as PipelineError).code).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });
});

describe('validateChatRequest - conversationSummary and memories', () => {
  const base = {
    model: { id: 'gpt-5.2', name: 'GPT-5.2' },
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('accepts a conversationSummary within the cap', () => {
    const validator = new InputValidator();
    const result = validator.validateChatRequest({
      ...base,
      conversationSummary: 'Earlier the user asked about X.',
    });
    expect(result.conversationSummary).toBe('Earlier the user asked about X.');
  });

  it('accepts a conversationSummary at exactly 8000 chars', () => {
    const validator = new InputValidator();
    const summary = 'x'.repeat(8000);
    expect(
      validator.validateChatRequest({ ...base, conversationSummary: summary })
        .conversationSummary,
    ).toBe(summary);
  });

  it('rejects a conversationSummary over 8000 chars', () => {
    const validator = new InputValidator();
    try {
      validator.validateChatRequest({
        ...base,
        conversationSummary: 'x'.repeat(8001),
      });
      expect.fail('Should have thrown PipelineError');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as PipelineError).code).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it('accepts memories within the caps', () => {
    const validator = new InputValidator();
    const memories = ['Works in logistics', 'Prefers concise answers'];
    expect(
      validator.validateChatRequest({ ...base, memories }).memories,
    ).toEqual(memories);
  });

  it('accepts 60 memories of 600 chars each (at-cap)', () => {
    const validator = new InputValidator();
    const memories = Array.from({ length: 60 }, () => 'm'.repeat(600));
    expect(
      validator.validateChatRequest({ ...base, memories }).memories,
    ).toHaveLength(60);
  });

  it('rejects more than 60 memories', () => {
    const validator = new InputValidator();
    expect(() =>
      validator.validateChatRequest({
        ...base,
        memories: Array.from({ length: 61 }, (_, i) => `memory ${i}`),
      }),
    ).toThrow(PipelineError);
  });

  it('rejects a memory item over 600 chars', () => {
    const validator = new InputValidator();
    expect(() =>
      validator.validateChatRequest({
        ...base,
        memories: ['ok', 'x'.repeat(601)],
      }),
    ).toThrow(PipelineError);
  });

  it('leaves both fields undefined when absent', () => {
    const validator = new InputValidator();
    const result = validator.validateChatRequest(base);
    expect(result.conversationSummary).toBeUndefined();
    expect(result.memories).toBeUndefined();
  });

  it('still rejects unknown top-level fields (schema stays strict)', () => {
    const validator = new InputValidator();
    expect(() =>
      validator.validateChatRequest({
        ...base,
        conversationSummaryV2: 'nope',
      }),
    ).toThrow(PipelineError);
    expect(() =>
      validator.validateChatRequest({ ...base, somethingElse: true }),
    ).toThrow(PipelineError);
  });
});

describe('validateChatRequest - hostedRegion', () => {
  const base = {
    model: { id: 'gpt-5.2', name: 'GPT-5.2' },
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('accepts US and EU', () => {
    const validator = new InputValidator();
    expect(
      validator.validateChatRequest({ ...base, hostedRegion: 'EU' })
        .hostedRegion,
    ).toBe('EU');
    expect(
      validator.validateChatRequest({ ...base, hostedRegion: 'US' })
        .hostedRegion,
    ).toBe('US');
  });

  it('is optional', () => {
    const validator = new InputValidator();
    expect(validator.validateChatRequest(base).hostedRegion).toBeUndefined();
  });

  it('rejects anything outside the enum (no arbitrary routing hints)', () => {
    const validator = new InputValidator();
    expect(() =>
      validator.validateChatRequest({ ...base, hostedRegion: 'APAC' }),
    ).toThrow();
    expect(() =>
      validator.validateChatRequest({
        ...base,
        hostedRegion: 'https://evil.example',
      }),
    ).toThrow();
  });
});

describe('validateChatRequest - interpreterMode', () => {
  const base = {
    model: { id: 'gpt-5.2', name: 'GPT-5.2' },
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('accepts every InterpreterMode value', () => {
    const validator = new InputValidator();
    for (const mode of Object.values(InterpreterMode)) {
      expect(
        validator.validateChatRequest({ ...base, interpreterMode: mode })
          .interpreterMode,
      ).toBe(mode);
    }
  });

  it('is optional', () => {
    const validator = new InputValidator();
    expect(validator.validateChatRequest(base).interpreterMode).toBeUndefined();
  });

  it('rejects values outside the enum', () => {
    const validator = new InputValidator();
    expect(() =>
      validator.validateChatRequest({ ...base, interpreterMode: 'turbo' }),
    ).toThrow();
    expect(() =>
      validator.validateChatRequest({ ...base, interpreterMode: 'agent' }),
    ).toThrow();
  });
});

describe('validateChatRequest - webSearchOptions.provider', () => {
  const base = {
    model: { id: 'gpt-5.2', name: 'GPT-5.2' },
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('keeps the provider selection (the regression: it used to be stripped)', () => {
    const validator = new InputValidator();
    for (const provider of [
      'auto',
      'news',
      'google-news',
      'gdelt',
      'bing-agent',
      'combined',
    ]) {
      const result = validator.validateChatRequest({
        ...base,
        webSearchOptions: { resultCount: 8, freshness: 'any', provider },
      });
      expect(result.webSearchOptions?.provider).toBe(provider);
    }
  });

  it('accepts webSearchOptions without a provider (older clients)', () => {
    const validator = new InputValidator();
    const result = validator.validateChatRequest({
      ...base,
      webSearchOptions: { resultCount: 8, freshness: 'any' },
    });
    expect(result.webSearchOptions?.provider).toBeUndefined();
  });

  it('rejects unknown providers', () => {
    const validator = new InputValidator();
    expect(() =>
      validator.validateChatRequest({
        ...base,
        webSearchOptions: {
          resultCount: 8,
          freshness: 'any',
          provider: 'altavista',
        },
      }),
    ).toThrow();
  });
});

describe('validateChatRequest - precomputedSearchResults', () => {
  const base = {
    model: { id: 'gpt-5.2', name: 'GPT-5.2' },
    messages: [{ role: 'user' as const, content: 'hi' }],
  };
  const entry = {
    title: 'Headline',
    url: 'https://example.com/a',
    date: '2026-07-23',
    sourceName: 'example.com',
    snippet: 'Snippet text',
  };

  it('accepts a bounded echo payload', () => {
    const validator = new InputValidator();
    const result = validator.validateChatRequest({
      ...base,
      precomputedSearchResults: { queries: ['q1', 'q2'], entries: [entry] },
    });
    expect(result.precomputedSearchResults?.entries).toHaveLength(1);
    expect(result.precomputedSearchResults?.queries).toEqual(['q1', 'q2']);
  });

  it('rejects non-http(s) entry URLs (clickable-citation injection)', () => {
    const validator = new InputValidator();
    expect(() =>
      validator.validateChatRequest({
        ...base,
        precomputedSearchResults: {
          queries: ['q'],
          // eslint-disable-next-line no-script-url
          entries: [{ ...entry, url: 'javascript:alert(1)' }],
        },
      }),
    ).toThrow();
    expect(() =>
      validator.validateChatRequest({
        ...base,
        precomputedSearchResults: {
          queries: ['q'],
          entries: [{ ...entry, sourceUrl: 'data:text/html,x' }],
        },
      }),
    ).toThrow();
  });

  it('rejects empty entries and oversized lists', () => {
    const validator = new InputValidator();
    expect(() =>
      validator.validateChatRequest({
        ...base,
        precomputedSearchResults: { queries: ['q'], entries: [] },
      }),
    ).toThrow();
    expect(() =>
      validator.validateChatRequest({
        ...base,
        precomputedSearchResults: {
          queries: ['q'],
          entries: Array.from({ length: 40 }, (_, i) => ({
            ...entry,
            url: `https://example.com/${i}`,
          })),
        },
      }),
    ).toThrow();
  });
});
