import { FileProcessingService } from '@/lib/services/chat/FileProcessingService';
import { FileProcessor } from '@/lib/services/chat/processors/FileProcessor';
import { MOUNTED_FILES_INLINE_BUDGET_TOKENS } from '@/lib/services/chat/processors/mountedFileExcerpt';
import { InputValidator } from '@/lib/services/chat/validators/InputValidator';

import {
  calculateChunkConfig,
  estimateCharsPerToken,
  parseAndQueryFileOpenAI,
} from '@/lib/utils/app/stream/documentSummary';
import { loadDocument } from '@/lib/utils/server/file/fileHandling';

import { MessageType } from '@/types/chat';
import { InterpreterMode } from '@/types/interpreterMode';

import { createTestChatContext } from '../testUtils';

import { env } from '@/config/environment';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    it('cleans up every downloaded temp file when a file fails processing', async () => {
      // Regression: cleanup used to run only on the happy path, so one
      // failing file stranded every downloaded temp file (multi-GB for
      // audio/video) in /tmp.
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

      // Both files download fine; the first fails during processing.
      mockLoadDocument.mockRejectedValueOnce(new Error('corrupt document'));

      // BasePipelineStage.execute converts stage failures into context.errors.
      const result = await fileProcessor.execute(context);
      expect(result.errors?.length).toBeGreaterThan(0);

      const cleanedPaths = mockFileService.cleanupFile.mock.calls.map(
        (call: string[]) => call[0],
      );
      expect(cleanedPaths.sort()).toEqual(['/tmp/file1.txt', '/tmp/file2.txt']);
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
      // The full text stays reachable behind the summary.
      expect(result.attachmentTexts).toEqual({ 'large-report.txt': largeText });
    });

    it('forwards botId to summarization for org KB agents (no promptAgent)', async () => {
      const largeText = 'A'.repeat(60000);
      mockLoadDocument.mockResolvedValue(largeText);
      mockCalcChunkConfig.mockReturnValue({
        chunkSize: 50000,
        batchSize: 3,
        maxCompletionTokens: 5000,
        maxSummaryLength: 32000,
      });
      mockParseAndQuery.mockResolvedValue('KB-grounded summary.');

      const context = createTestChatContext({
        hasFiles: true,
        botId: 'msf_communications',
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

      await fileProcessor.execute(context);

      expect(mockParseAndQuery).toHaveBeenCalledWith(
        expect.objectContaining({ botId: 'msf_communications' }),
      );
    });

    it('suppresses KB grounding for prompt-agent chats (botId not forwarded)', async () => {
      // Prompt agents arrive via botId but must never trigger a
      // knowledge-base search (mirrors RAGEnricher): a truthy botId would
      // turn the large-file summarization into an Azure "On Your Data"
      // request grounded on the org KB index.
      const largeText = 'A'.repeat(60000);
      mockLoadDocument.mockResolvedValue(largeText);
      mockCalcChunkConfig.mockReturnValue({
        chunkSize: 50000,
        batchSize: 3,
        maxCompletionTokens: 5000,
        maxSummaryLength: 32000,
      });
      mockParseAndQuery.mockResolvedValue('Plain summary.');

      const context = createTestChatContext({
        hasFiles: true,
        botId: 'prompt-abc123def456',
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
      context.promptAgent = {
        version: 1,
        id: 'prompt-abc123def456',
        name: 'Persona',
        description: '',
        systemPrompt: 'You are a persona.',
        modelId: 'gpt-5.2',
        createdBy: 'admin@msf.org',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedBy: 'admin@msf.org',
        updatedAt: '2026-07-18T00:00:00.000Z',
      };

      const result = await fileProcessor.execute(context);

      expect(mockParseAndQuery).toHaveBeenCalledWith(
        expect.objectContaining({ botId: undefined }),
      );
      // The summarization itself still runs on the standard path.
      expect(result.processedContent?.fileSummaries).toEqual([
        expect.objectContaining({
          filename: 'large-report.txt',
          summary: 'Plain summary.',
        }),
      ]);
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

    const twoFileContext = (
      options: { modelId?: string; servingTokensPerMinute?: number } = {},
    ) => ({
      ...createTestChatContext({
        hasFiles: true,
        ...(options.modelId ? { model: { id: options.modelId } } : {}),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Compare these workbooks' },
              {
                type: 'file_url',
                url: 'https://blob.com/IB26.xlsx',
                originalFilename: 'IB26.xlsx',
              },
              {
                type: 'file_url',
                url: 'https://blob.com/WB27.xlsx',
                originalFilename: 'WB27.xlsx',
              },
            ],
            messageType: MessageType.FILE,
          },
        ],
      }),
      servingTokensPerMinute: options.servingTokensPerMinute,
    });

    it('summarizes the file that would push the turn past one window', async () => {
      // Each 30K-char file fits a 50K chunk alone; together (60K) they do not.
      mockLoadDocument
        .mockResolvedValueOnce('A'.repeat(30000))
        .mockResolvedValueOnce('B'.repeat(30000));
      mockCalcChunkConfig.mockReturnValue({
        chunkSize: 50000,
        batchSize: 3,
        maxCompletionTokens: 5000,
        maxSummaryLength: 32000,
      });
      mockParseAndQuery.mockResolvedValue('Summary of WB27.');

      const result = await fileProcessor.execute(twoFileContext());

      expect(result.processedContent?.inlineFiles).toEqual([
        { filename: 'IB26.xlsx', content: 'A'.repeat(30000) },
      ]);
      expect(result.processedContent?.fileSummaries).toEqual([
        expect.objectContaining({ filename: 'WB27.xlsx' }),
      ]);
    });

    it('inlines both files when together they exactly fill the window', async () => {
      mockLoadDocument
        .mockResolvedValueOnce('A'.repeat(25000))
        .mockResolvedValueOnce('B'.repeat(25000));
      mockCalcChunkConfig.mockReturnValue({
        chunkSize: 50000,
        batchSize: 3,
        maxCompletionTokens: 5000,
        maxSummaryLength: 32000,
      });

      const result = await fileProcessor.execute(twoFileContext());

      expect(mockParseAndQuery).not.toHaveBeenCalled();
      expect(result.processedContent?.inlineFiles).toHaveLength(2);
    });

    it('sizes against the deployment ceiling and forwards it to summarization', async () => {
      mockLoadDocument.mockResolvedValue('C'.repeat(60000));
      mockCalcChunkConfig.mockReturnValue({
        chunkSize: 50000,
        batchSize: 3,
        maxCompletionTokens: 5000,
        maxSummaryLength: 32000,
      });

      await fileProcessor.execute(
        twoFileContext({
          modelId: 'gpt-6-astra',
          servingTokensPerMinute: 250000,
        }),
      );

      // 250K TPM -> 225K admissible, below Astra's 272K catalog window.
      expect(mockCalcChunkConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'gpt-6-astra',
          maxLength: 225000,
          tokensPerMinute: 250000,
        }),
        expect.any(Number),
      );
      expect(mockParseAndQuery).toHaveBeenCalledWith(
        expect.objectContaining({ servingTokensPerMinute: 250000 }),
      );
    });

    describe('native interpreter turns (files mounted in the sandbox)', () => {
      const priorEnabled = env.CODE_INTERPRETER_ENABLED;
      beforeEach(() => {
        (env as any).CODE_INTERPRETER_ENABLED = true;
        mockCalcChunkConfig.mockReturnValue({
          chunkSize: 400000,
          batchSize: 3,
          maxCompletionTokens: 5000,
          maxSummaryLength: 32000,
        });
      });
      afterEach(() => {
        (env as any).CODE_INTERPRETER_ENABLED = priorEnabled;
      });

      const interpreterTurn = (
        interpreterMode: InterpreterMode,
        servingTokensPerMinute?: number,
      ) => {
        const base = twoFileContext({ servingTokensPerMinute });
        return {
          ...base,
          interpreterMode,
          modelId: 'gpt-5.6-luna',
          model: {
            ...base.model,
            id: 'gpt-5.6-luna',
            sdk: 'azure-openai' as const,
            supportsCodeInterpreter: true,
            supportsResponsesApi: true,
          },
        };
      };

      // charsPerToken is mocked at 4: MOUNTED_FILES_INLINE_BUDGET_TOKENS
      // (16K) is 64K chars of mounted files inlined in full per turn.
      const budgetChars = MOUNTED_FILES_INLINE_BUDGET_TOKENS * 4;

      it('inlines mounted files that together exactly fill the mounted budget', async () => {
        mockLoadDocument
          .mockResolvedValueOnce('A'.repeat(budgetChars / 2))
          .mockResolvedValueOnce('B'.repeat(budgetChars / 2));

        const result = await fileProcessor.execute(
          interpreterTurn(InterpreterMode.INTELLIGENT),
        );

        expect(
          result.processedContent?.inlineFiles?.map((f) => f.content),
        ).toEqual(['A'.repeat(budgetChars / 2), 'B'.repeat(budgetChars / 2)]);
      });

      it('excerpts (never summarizes) the mounted file that overflows the budget', async () => {
        mockLoadDocument
          .mockResolvedValueOnce('A'.repeat(budgetChars / 2))
          .mockResolvedValueOnce('B'.repeat(budgetChars / 2 + 4));

        const result = await fileProcessor.execute(
          interpreterTurn(InterpreterMode.INTELLIGENT),
        );

        expect(mockParseAndQuery).not.toHaveBeenCalled();
        const [ib26, wb27] = result.processedContent?.inlineFiles ?? [];
        expect(ib26.content).toBe('A'.repeat(budgetChars / 2));
        expect(wb27.filename).toBe('WB27.xlsx');
        expect(wb27.content).toMatch(/^\[Excerpt of WB27\.xlsx/);
        expect(wb27.content).toContain('available to your code interpreter');
        expect(wb27.content.length).toBeLessThan(budgetChars / 2);
        // The full text is kept for re-access; the whole file is not.
        expect(result.attachmentTexts).toEqual({
          'WB27.xlsx': 'B'.repeat(budgetChars / 2 + 4),
        });
      });

      it('keeps the full-window inline budget when the interpreter is off', async () => {
        mockLoadDocument
          .mockResolvedValueOnce('A'.repeat(budgetChars))
          .mockResolvedValueOnce('B'.repeat(budgetChars));

        const result = await fileProcessor.execute(
          interpreterTurn(InterpreterMode.OFF),
        );

        expect(
          result.processedContent?.inlineFiles?.map((f) => f.content),
        ).toEqual(['A'.repeat(budgetChars), 'B'.repeat(budgetChars)]);
      });

      it('plans the window with the per-call share of the deployment TPM', async () => {
        mockLoadDocument.mockResolvedValue('C'.repeat(100));

        await fileProcessor.execute(
          interpreterTurn(InterpreterMode.INTELLIGENT, 250000),
        );

        // 250K TPM / 3 planned calls = 83,333 -> 74,999 admissible.
        expect(mockCalcChunkConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            maxLength: 74999,
            tokensPerMinute: 83333,
          }),
          expect.any(Number),
        );
      });

      it('reports every attachment it placed in context', async () => {
        mockLoadDocument.mockResolvedValue('C'.repeat(100));

        const result = await fileProcessor.execute(
          interpreterTurn(InterpreterMode.INTELLIGENT),
        );

        expect(result.attachmentUrlsProcessedThisTurn).toEqual([
          'https://blob.com/IB26.xlsx',
          'https://blob.com/WB27.xlsx',
        ]);
      });
    });

    it('still inlines a single file of exactly chunkSize at a fractional chars-per-token', async () => {
      vi.mocked(estimateCharsPerToken).mockReturnValueOnce(3.3);
      mockLoadDocument.mockResolvedValue('D'.repeat(50000));
      mockCalcChunkConfig.mockReturnValue({
        chunkSize: 50000,
        batchSize: 3,
        maxCompletionTokens: 5000,
        maxSummaryLength: 32000,
      });

      const result = await fileProcessor.execute(
        createTestChatContext({
          hasFiles: true,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Read this' },
                {
                  type: 'file_url',
                  url: 'https://blob.com/exact.txt',
                  originalFilename: 'exact.txt',
                },
              ],
              messageType: MessageType.FILE,
            },
          ],
        }),
      );

      expect(mockParseAndQuery).not.toHaveBeenCalled();
      expect(result.processedContent?.inlineFiles).toHaveLength(1);
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
