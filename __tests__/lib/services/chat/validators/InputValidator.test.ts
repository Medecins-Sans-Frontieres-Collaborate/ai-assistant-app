import { Session } from 'next-auth';

import { InputValidator } from '@/lib/services/chat/validators/InputValidator';

import { VALIDATION_LIMITS } from '@/lib/utils/app/const';

import { ErrorCode, PipelineError } from '@/types/errors';

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
