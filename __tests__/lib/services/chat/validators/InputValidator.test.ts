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
});
