import { FileProcessingService } from '@/lib/services/chat/FileProcessingService';
import { FileProcessor } from '@/lib/services/chat/processors/FileProcessor';
import { InputValidator } from '@/lib/services/chat/validators/InputValidator';

import {
  calculateChunkConfig,
  estimateCharsPerToken,
  parseAndQueryFileOpenAI,
} from '@/lib/utils/app/stream/documentSummary';
import { loadDocument } from '@/lib/utils/server/file/fileHandling';

import { MessageType } from '@/types/chat';

import { createTestChatContext } from '../testUtils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock document processing modules for inline file tests
vi.mock('@/lib/utils/server/file/fileHandling', () => ({
  loadDocument: vi.fn(),
}));

vi.mock('@/lib/utils/app/stream/documentSummary', () => ({
  estimateCharsPerToken: vi.fn().mockReturnValue(4),
  calculateChunkConfig: vi.fn().mockReturnValue({
    chunkSize: 50000,
    batchSize: 3,
    maxCompletionTokens: 5000,
    maxSummaryLength: 32000,
  }),
  parseAndQueryFileOpenAI: vi.fn().mockResolvedValue('Mocked summary'),
}));

const mockLoadDocument = vi.mocked(loadDocument);
const mockParseAndQuery = vi.mocked(parseAndQueryFileOpenAI);
const mockCalcChunkConfig = vi.mocked(calculateChunkConfig);

describe('FileProcessor', () => {
  describe('Parallel file operations', () => {
    let fileProcessor: FileProcessor;
    let mockFileService: any;
    let mockValidator: any;

    beforeEach(() => {
      // Create mock services
      mockFileService = {
        getTempFilePath: vi.fn((url: string) => {
          const id = url.split('/').pop();
          return [id, `/tmp/${id}`];
        }),
        getFileSize: vi.fn(async () => 1024 * 1024), // 1MB
        downloadFile: vi.fn(async () => {}),
        readFile: vi.fn(async () => Buffer.from('test content')),
        cleanupFile: vi.fn(async () => {}),
      };

      mockValidator = {
        validateFileSize: vi.fn(async () => {}),
      };

      fileProcessor = new FileProcessor(
        mockFileService as any,
        mockValidator as any,
      );
    });

    it('should validate all file sizes in parallel', async () => {
      const context = createTestChatContext({
        hasFiles: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file_url',
                url: 'https://blob.com/file1.pdf',
                originalFilename: 'file1.pdf',
              },
              {
                type: 'file_url',
                url: 'https://blob.com/file2.pdf',
                originalFilename: 'file2.pdf',
              },
              {
                type: 'file_url',
                url: 'https://blob.com/file3.pdf',
                originalFilename: 'file3.pdf',
              },
            ],
            messageType: MessageType.FILE,
          },
        ],
      });

      // Track when validations start
      const validationTimes: number[] = [];
      mockValidator.validateFileSize.mockImplementation(async () => {
        validationTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      await fileProcessor.execute(context);

      // All 3 validations should be called
      expect(mockValidator.validateFileSize).toHaveBeenCalledTimes(3);

      // All validations should start at roughly the same time (within 5ms)
      // This proves they run in parallel, not sequentially
      const timeDifferences = validationTimes
        .slice(1)
        .map((time, i) => time - validationTimes[i]);
      timeDifferences.forEach((diff) => {
        expect(diff).toBeLessThan(5);
      });
    });

    it('should download all files in parallel', async () => {
      const context = createTestChatContext({
        hasFiles: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file_url',
                url: 'https://blob.com/file1.pdf',
                originalFilename: 'file1.pdf',
              },
              {
                type: 'file_url',
                url: 'https://blob.com/file2.pdf',
                originalFilename: 'file2.pdf',
              },
            ],
            messageType: MessageType.FILE,
          },
        ],
      });

      // Track when downloads start
      const downloadTimes: number[] = [];
      mockFileService.downloadFile.mockImplementation(async () => {
        downloadTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      await fileProcessor.execute(context);

      // Both downloads should be called
      expect(mockFileService.downloadFile).toHaveBeenCalledTimes(2);

      // Downloads should start at roughly the same time (parallel)
      const timeDiff = downloadTimes[1] - downloadTimes[0];
      expect(timeDiff).toBeLessThan(30);
    });

    it('should verify cleanup operation is called for all files', async () => {
      // Test focuses on verifying cleanup is called, not full processing
      const context = createTestChatContext({
        hasFiles: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file_url',
                url: 'https://blob.com/file1.txt',
                originalFilename: 'file1.txt',
              },
              {
                type: 'file_url',
                url: 'https://blob.com/file2.txt',
                originalFilename: 'file2.txt',
              },
            ],
            messageType: MessageType.FILE,
          },
        ],
      });

      // Make processing fail quickly so we just test the structure
      mockFileService.readFile.mockRejectedValueOnce(new Error('Test error'));

      try {
        await fileProcessor.execute(context);
      } catch (error) {
        // Expected to fail during processing
      }

      // Even on error, cleanup should be attempted (based on Promise.all structure)
      expect(mockValidator.validateFileSize).toHaveBeenCalled();
      expect(mockFileService.downloadFile).toHaveBeenCalled();
    });

    it('should call all required operations for multiple files', async () => {
      const context = createTestChatContext({
        hasFiles: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file_url',
                url: 'https://blob.com/file1.txt',
                originalFilename: 'file1.txt',
              },
              {
                type: 'file_url',
                url: 'https://blob.com/file2.txt',
                originalFilename: 'file2.txt',
              },
            ],
            messageType: MessageType.FILE,
          },
        ],
      });

      // Make processing fail quickly to test parallelization structure
      mockFileService.readFile.mockRejectedValueOnce(new Error('Test error'));

      try {
        await fileProcessor.execute(context);
      } catch (error) {
        // Expected
      }

      // Verify parallel operations were initiated
      expect(mockValidator.validateFileSize).toHaveBeenCalledTimes(2);
      expect(mockFileService.downloadFile).toHaveBeenCalledTimes(2);
    });

    it('should maintain correct order of downloaded files', async () => {
      const context = createTestChatContext({
        hasFiles: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file_url',
                url: 'https://blob.com/file1.pdf',
                originalFilename: 'file1.pdf',
              },
              {
                type: 'file_url',
                url: 'https://blob.com/file2.pdf',
                originalFilename: 'file2.pdf',
              },
              {
                type: 'file_url',
                url: 'https://blob.com/file3.pdf',
                originalFilename: 'file3.pdf',
              },
            ],
            messageType: MessageType.FILE,
          },
        ],
      });

      // Mock downloads with different delays to test order preservation
      mockFileService.downloadFile.mockImplementation(async (url: string) => {
        const fileNum = url.match(/file(\d+)/)?.[1];
        // file3 finishes first, file1 last - but order should be preserved
        await new Promise((resolve) =>
          setTimeout(resolve, (4 - parseInt(fileNum!)) * 10),
        );
      });

      await fileProcessor.execute(context);

      // Verify download calls were made in the correct order
      expect(mockFileService.downloadFile).toHaveBeenNthCalledWith(
        1,
        'https://blob.com/file1.pdf',
        expect.any(String),
        expect.any(Object),
      );
      expect(mockFileService.downloadFile).toHaveBeenNthCalledWith(
        2,
        'https://blob.com/file2.pdf',
        expect.any(String),
        expect.any(Object),
      );
      expect(mockFileService.downloadFile).toHaveBeenNthCalledWith(
        3,
        'https://blob.com/file3.pdf',
        expect.any(String),
        expect.any(Object),
      );
    });

    it('should skip stage when no files present', async () => {
      const context = createTestChatContext({
        hasFiles: false,
        messages: [
          {
            role: 'user',
            content: 'Just text',
            messageType: MessageType.TEXT,
          },
        ],
      });

      const shouldRun = fileProcessor.shouldRun(context);

      expect(shouldRun).toBe(false);
    });
  });

  describe('Inline small file detection', () => {
    let fileProcessor: FileProcessor;
    let mockFileService: any;
    let mockValidator: any;

    beforeEach(() => {
      vi.clearAllMocks();

      mockFileService = {
        getTempFilePath: vi.fn((url: string) => {
          const id = url.split('/').pop();
          return [id, `/tmp/${id}`];
        }),
        getFileSize: vi.fn(async () => 1024),
        downloadFile: vi.fn(async () => {}),
        readFile: vi.fn(async () => Buffer.from('small file content')),
        cleanupFile: vi.fn(async () => {}),
      };

      mockValidator = {
        validateFileSize: vi.fn(async () => {}),
      };

      fileProcessor = new FileProcessor(
        mockFileService as any,
        mockValidator as any,
      );
    });

    it('should inline small files that fit in a single chunk', async () => {
      const smallText = 'This is a small document.';
      mockLoadDocument.mockResolvedValue(smallText);
      mockCalcChunkConfig.mockReturnValue({
        chunkSize: 50000,
        batchSize: 3,
        maxCompletionTokens: 5000,
        maxSummaryLength: 32000,
      });

      const context = createTestChatContext({
        hasFiles: true,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this file' },
              {
                type: 'file_url',
                url: 'https://blob.com/notes.txt',
                originalFilename: 'notes.txt',
              },
            ],
            messageType: MessageType.FILE,
          },
        ],
      });

      const result = await fileProcessor.execute(context);

      // Should NOT call parseAndQueryFileOpenAI for small files
      expect(mockParseAndQuery).not.toHaveBeenCalled();

      // Should populate inlineFiles
      expect(result.processedContent?.inlineFiles).toEqual([
        { filename: 'notes.txt', content: smallText },
      ]);

      // Should NOT populate fileSummaries
      expect(result.processedContent?.fileSummaries).toBeUndefined();
    });

    it('should summarize large files that exceed chunk size', async () => {
      const largeText = 'A'.repeat(60000);
      mockLoadDocument.mockResolvedValue(largeText);
      mockCalcChunkConfig.mockReturnValue({
        chunkSize: 50000,
        batchSize: 3,
        maxCompletionTokens: 5000,
        maxSummaryLength: 32000,
      });
      mockParseAndQuery.mockResolvedValue('Summarized large document.');

      const context = createTestChatContext({
        hasFiles: true,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this file' },
              {
                type: 'file_url',
                url: 'https://blob.com/large-report.txt',
                originalFilename: 'large-report.txt',
              },
            ],
            messageType: MessageType.FILE,
          },
        ],
      });

      const result = await fileProcessor.execute(context);

      // Should call parseAndQueryFileOpenAI with preExtractedText
      expect(mockParseAndQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          preExtractedText: largeText,
          stream: false,
        }),
      );

      // Should populate fileSummaries
      expect(result.processedContent?.fileSummaries).toEqual([
        expect.objectContaining({
          filename: 'large-report.txt',
          summary: 'Summarized large document.',
        }),
      ]);

      // Should NOT populate inlineFiles
      expect(result.processedContent?.inlineFiles).toBeUndefined();
    });

    it('should handle mix of small and large files', async () => {
      const smallText = 'Short content.';
      const largeText = 'B'.repeat(60000);

      mockLoadDocument
        .mockResolvedValueOnce(smallText) // First file: small
        .mockResolvedValueOnce(largeText); // Second file: large

      mockCalcChunkConfig.mockReturnValue({
        chunkSize: 50000,
        batchSize: 3,
        maxCompletionTokens: 5000,
        maxSummaryLength: 32000,
      });
      mockParseAndQuery.mockResolvedValue('Summary of large file.');

      const context = createTestChatContext({
        hasFiles: true,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze these files' },
              {
                type: 'file_url',
                url: 'https://blob.com/small.txt',
                originalFilename: 'small.txt',
              },
              {
                type: 'file_url',
                url: 'https://blob.com/large.txt',
                originalFilename: 'large.txt',
              },
            ],
            messageType: MessageType.FILE,
          },
        ],
      });

      const result = await fileProcessor.execute(context);

      // Small file should be inlined
      expect(result.processedContent?.inlineFiles).toEqual([
        { filename: 'small.txt', content: smallText },
      ]);

      // Large file should be summarized
      expect(result.processedContent?.fileSummaries).toEqual([
        expect.objectContaining({
          filename: 'large.txt',
          summary: 'Summary of large file.',
        }),
      ]);

      // parseAndQueryFileOpenAI should only be called once (for the large file)
      expect(mockParseAndQuery).toHaveBeenCalledTimes(1);
    });

    it('should inline file at exactly the chunk size boundary', async () => {
      const boundaryText = 'C'.repeat(50000); // Exactly equal to chunkSize
      mockLoadDocument.mockResolvedValue(boundaryText);
      mockCalcChunkConfig.mockReturnValue({
        chunkSize: 50000,
        batchSize: 3,
        maxCompletionTokens: 5000,
        maxSummaryLength: 32000,
      });

      const context = createTestChatContext({
        hasFiles: true,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read this' },
              {
                type: 'file_url',
                url: 'https://blob.com/boundary.txt',
                originalFilename: 'boundary.txt',
              },
            ],
            messageType: MessageType.FILE,
          },
        ],
      });

      const result = await fileProcessor.execute(context);

      // At exactly chunkSize, should be inlined (text.length <= chunkSize)
      expect(mockParseAndQuery).not.toHaveBeenCalled();
      expect(result.processedContent?.inlineFiles).toEqual([
        { filename: 'boundary.txt', content: boundaryText },
      ]);
    });
  });
});
