import type { TextCompleter } from '@/lib/services/chat/textCompletion';

import { CHUNK_CONFIG, TOKEN_ESTIMATION } from '@/lib/utils/app/const';
import {
  calculateChunkConfig,
  estimateCharsPerToken,
  splitIntoChunks,
  summarizeDocumentForQuery,
} from '@/lib/utils/app/stream/documentSummary';
import {
  admissibleRequestTokens,
  applyAdmissionCeiling,
} from '@/lib/utils/shared/modelThroughput';

import { OpenAIModel } from '@/types/openai';

import { describe, expect, it, vi } from 'vitest';

// Mock external dependencies for parseAndQueryFileOpenAI tests
const mockLoadDocument = vi.fn();
vi.mock('@/lib/utils/server/file/fileHandling', () => ({
  loadDocument: (...args: any[]) => mockLoadDocument(...args),
}));

describe('Document Summary Utilities', () => {
  describe('estimateCharsPerToken', () => {
    it('should return LATIN (4) for English text', () => {
      const englishText =
        'This is a sample English document with typical Latin characters and punctuation.';
      const result = estimateCharsPerToken(englishText);
      expect(result).toBe(TOKEN_ESTIMATION.LATIN);
    });

    it('should return CJK (1.5) for Chinese text', () => {
      const chineseText =
        '这是一个中文文档示例，包含典型的中文字符。这个文档用于测试字符统计功能是否正确工作。';
      const result = estimateCharsPerToken(chineseText);
      expect(result).toBe(TOKEN_ESTIMATION.CJK);
    });

    it('should return CJK (1.5) for Japanese text with Kanji', () => {
      const japaneseText =
        '日本語のテストドキュメントです。漢字とひらがなとカタカナを含んでいます。これはテスト用のテキストです。';
      const result = estimateCharsPerToken(japaneseText);
      expect(result).toBe(TOKEN_ESTIMATION.CJK);
    });

    it('should return CJK (1.5) for Japanese text with Hiragana/Katakana', () => {
      const japaneseKana =
        'これはひらがなとカタカナのみのテストです。日本語のテキストをテストしています。';
      const result = estimateCharsPerToken(japaneseKana);
      expect(result).toBe(TOKEN_ESTIMATION.CJK);
    });

    it('should return RTL_CYRILLIC (2.5) for Arabic text', () => {
      const arabicText =
        'هذا نص عربي للاختبار. يحتوي على أحرف عربية نموذجية لاختبار تقدير الرموز.';
      const result = estimateCharsPerToken(arabicText);
      expect(result).toBe(TOKEN_ESTIMATION.RTL_CYRILLIC);
    });

    it('should return RTL_CYRILLIC (2.5) for Hebrew text', () => {
      const hebrewText =
        'זהו טקסט בעברית לבדיקה. הטקסט מכיל תווים עבריים טיפוסיים לבדיקת הערכת אסימונים.';
      const result = estimateCharsPerToken(hebrewText);
      expect(result).toBe(TOKEN_ESTIMATION.RTL_CYRILLIC);
    });

    it('should return RTL_CYRILLIC (2.5) for Russian (Cyrillic) text', () => {
      const russianText =
        'Это тестовый текст на русском языке. Он содержит типичные кириллические символы.';
      const result = estimateCharsPerToken(russianText);
      expect(result).toBe(TOKEN_ESTIMATION.RTL_CYRILLIC);
    });

    it('should return LATIN (4) for mixed text with <30% non-Latin', () => {
      // Create text with mostly Latin but some non-Latin (<30%)
      const mixedText =
        'This is primarily English text with a few 中文 characters mixed in for testing.';
      const result = estimateCharsPerToken(mixedText);
      expect(result).toBe(TOKEN_ESTIMATION.LATIN);
    });

    it('should return CJK when CJK dominates over RTL in mixed non-Latin text', () => {
      // More CJK than RTL characters (20 CJK vs 8 Arabic)
      const mixedNonLatin = '中文字符很多很多很多文字测试内容更多中文 مع قليل';
      const result = estimateCharsPerToken(mixedNonLatin);
      expect(result).toBe(TOKEN_ESTIMATION.CJK);
    });

    it('should return RTL_CYRILLIC when RTL dominates over CJK in mixed non-Latin text', () => {
      // More RTL than CJK characters
      const mixedNonLatin = 'نص عربي طويل جدا مع القليل من 中文';
      const result = estimateCharsPerToken(mixedNonLatin);
      expect(result).toBe(TOKEN_ESTIMATION.RTL_CYRILLIC);
    });

    it('should return LATIN (4) for empty string', () => {
      const result = estimateCharsPerToken('');
      expect(result).toBe(TOKEN_ESTIMATION.LATIN);
    });

    it('should only sample first 1000 characters by default', () => {
      // Create text with Latin first 1000 chars, then CJK
      const latinPart = 'A'.repeat(1000);
      const cjkPart = '中'.repeat(500);
      const result = estimateCharsPerToken(latinPart + cjkPart);
      // Should only analyze Latin part
      expect(result).toBe(TOKEN_ESTIMATION.LATIN);
    });

    it('should use custom sample size when provided', () => {
      // Create text with Latin first 1000 chars, then CJK
      const latinPart = 'A'.repeat(1000);
      const cjkPart = '中'.repeat(1000);
      // With larger sample, should detect CJK (>30% of 2000 chars)
      const result = estimateCharsPerToken(latinPart + cjkPart, 2000);
      expect(result).toBe(TOKEN_ESTIMATION.CJK);
    });

    it('should return LATIN for text with only punctuation and numbers', () => {
      const numbersAndPunctuation = '12345, 67890! @#$%^&*() 2024-01-15';
      const result = estimateCharsPerToken(numbersAndPunctuation);
      expect(result).toBe(TOKEN_ESTIMATION.LATIN);
    });
  });

  describe('calculateChunkConfig', () => {
    it('should return default values when no model is provided', () => {
      const config = calculateChunkConfig();

      expect(config.chunkSize).toBe(CHUNK_CONFIG.DEFAULT_CHUNK_CHARS);
      expect(config.batchSize).toBe(CHUNK_CONFIG.DEFAULT_BATCH_SIZE);
      expect(config.maxCompletionTokens).toBe(
        CHUNK_CONFIG.DEFAULT_MAX_COMPLETION_TOKENS,
      );
      expect(config.maxSummaryLength).toBe(CHUNK_CONFIG.DEFAULT_SUMMARY_LENGTH);
    });

    it('should return default values when undefined model is provided', () => {
      const config = calculateChunkConfig(undefined);

      expect(config.chunkSize).toBe(CHUNK_CONFIG.DEFAULT_CHUNK_CHARS);
      expect(config.batchSize).toBe(CHUNK_CONFIG.DEFAULT_BATCH_SIZE);
    });

    it('should calculate chunk size based on model context window (GPT-5.2 style)', () => {
      const model: OpenAIModel = {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        maxLength: 128000,
        tokenLimit: 16000,
      };

      const config = calculateChunkConfig(model);

      // New formula: each chunk uses nearly full context
      // maxCompletionTokens = min(5000, 16000/4) = 4000
      // promptOverhead = 100 + 200 = 300
      // availableInputTokens = 128000 - 4000 - 300 = 123700
      // rawChunkSize = 123700 * 4 = 494800, capped at MAX_CHUNK_CHARS (400000)
      expect(config.chunkSize).toBe(CHUNK_CONFIG.MAX_CHUNK_CHARS);
      // 128000 / 50000 = 2.56 → 2, clamped to MIN_BATCH_SIZE (3)
      expect(config.batchSize).toBe(CHUNK_CONFIG.MIN_BATCH_SIZE);
      // min(5000, 16000 / 4) = 4000
      expect(config.maxCompletionTokens).toBe(4000);
      // 16000 * 2 = 32000, within 16K-64K range
      expect(config.maxSummaryLength).toBe(32000);
    });

    describe('deployment throughput', () => {
      const astra: OpenAIModel = {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        maxLength: 272000,
        tokenLimit: 32000,
      };
      const burstTokens = (
        config: ReturnType<typeof calculateChunkConfig>,
      ): number =>
        config.batchSize *
        (Math.ceil(config.chunkSize / TOKEN_ESTIMATION.LATIN) +
          config.maxCompletionTokens +
          CHUNK_CONFIG.SYSTEM_PROMPT_TOKENS +
          CHUNK_CONFIG.PROMPT_WRAPPER_TOKENS);

      it('keeps window-based parallelism when throughput is unknown', () => {
        // 272000 / 50000 = 5 parallel near-window chunks.
        expect(calculateChunkConfig(astra).batchSize).toBe(5);
      });

      it('fits one batch inside a 250K TPM deployment (the 2026-11-06 burst)', () => {
        const config = calculateChunkConfig(
          applyAdmissionCeiling(astra, 250000),
        );
        expect(config.batchSize).toBeGreaterThanOrEqual(1);
        expect(config.batchSize).toBeLessThan(5);
        expect(burstTokens(config)).toBeLessThanOrEqual(
          admissibleRequestTokens(250000),
        );
      });

      it('goes below MIN_BATCH_SIZE rather than guarantee a rejection', () => {
        const config = calculateChunkConfig(
          applyAdmissionCeiling(astra, 100000),
        );
        expect(CHUNK_CONFIG.MIN_BATCH_SIZE).toBeGreaterThan(1);
        expect(config.batchSize).toBe(1);
        expect(burstTokens(config)).toBeLessThanOrEqual(
          admissibleRequestTokens(100000),
        );
      });

      it('restores full parallelism once capacity is raised', () => {
        const config = calculateChunkConfig(
          applyAdmissionCeiling(astra, 5000000),
        );
        expect(config.batchSize).toBe(5);
      });
    });

    it('should calculate larger values for o3 model with extended context', () => {
      const model: OpenAIModel = {
        id: 'o3',
        name: 'o3',
        maxLength: 200000,
        tokenLimit: 100000,
      };

      const config = calculateChunkConfig(model);

      // maxCompletionTokens = min(16000, 100000/4) = 16000 (ceiling)
      // availableInputTokens = 200000 - 16000 - 300 = 183700
      // rawChunkSize = 183700 * 4 = 734800, capped at MAX_CHUNK_CHARS
      expect(config.chunkSize).toBe(CHUNK_CONFIG.MAX_CHUNK_CHARS);
      // 200000 / 50000 = 4
      expect(config.batchSize).toBe(4);
      expect(config.maxCompletionTokens).toBe(
        CHUNK_CONFIG.DEFAULT_MAX_COMPLETION_TOKENS,
      );
      // 100000 * 2 = 200000, capped at MAX_SUMMARY_LENGTH
      expect(config.maxSummaryLength).toBe(CHUNK_CONFIG.MAX_SUMMARY_LENGTH);
    });

    it('should calculate appropriately for a model with limited context', () => {
      const model: OpenAIModel = {
        id: 'small-model',
        name: 'Small Model',
        maxLength: 16000,
        tokenLimit: 4000,
      };

      const config = calculateChunkConfig(model);

      // maxCompletionTokens = min(5000, 4000/4) = 1000
      // availableInputTokens = 16000 - 1000 - 300 = 14700
      // rawChunkSize = 14700 * 4 = 58800 (no longer capped with higher MAX)
      expect(config.chunkSize).toBe(58800);
      // 16000 / 50000 = 0.32 → 0, clamped to MIN_BATCH_SIZE
      expect(config.batchSize).toBe(CHUNK_CONFIG.MIN_BATCH_SIZE);
      // min(5000, 4000 / 4) = 1000
      expect(config.maxCompletionTokens).toBe(1000);
      // 4000 * 2 = 8000, clamped to MIN_SUMMARY_LENGTH
      expect(config.maxSummaryLength).toBe(CHUNK_CONFIG.MIN_SUMMARY_LENGTH);
    });

    it('should handle very small context windows appropriately', () => {
      const model: OpenAIModel = {
        id: 'tiny-model',
        name: 'Tiny Model',
        maxLength: 4000,
        tokenLimit: 1000,
      };

      const config = calculateChunkConfig(model);

      // maxCompletionTokens = min(5000, 1000/4) = 250
      // availableInputTokens = 4000 - 250 - 300 = 3450
      // rawChunkSize = 3450 * 4 = 13800 (within bounds)
      expect(config.chunkSize).toBe(13800);
      expect(config.batchSize).toBe(CHUNK_CONFIG.MIN_BATCH_SIZE);
      expect(config.maxSummaryLength).toBe(CHUNK_CONFIG.MIN_SUMMARY_LENGTH);
    });

    it('should handle Claude models with large output capacity', () => {
      const model: OpenAIModel = {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        maxLength: 200000,
        tokenLimit: 64000,
      };

      const config = calculateChunkConfig(model);

      // maxCompletionTokens = min(16000, 64000/4) = 16000 (both equal)
      // availableInputTokens = 200000 - 16000 - 300 = 183700
      // rawChunkSize = 183700 * 4 = 734800, capped at MAX_CHUNK_CHARS
      expect(config.chunkSize).toBe(CHUNK_CONFIG.MAX_CHUNK_CHARS);
      // 200000 / 50000 = 4
      expect(config.batchSize).toBe(4);
      expect(config.maxCompletionTokens).toBe(
        CHUNK_CONFIG.DEFAULT_MAX_COMPLETION_TOKENS,
      );
      // 64000 * 2 = 128000, capped at MAX_SUMMARY_LENGTH
      expect(config.maxSummaryLength).toBe(CHUNK_CONFIG.MAX_SUMMARY_LENGTH);
    });

    it('should handle DeepSeek models with moderate output limits', () => {
      const model: OpenAIModel = {
        id: 'deepseek-r1',
        name: 'DeepSeek-R1',
        maxLength: 128000,
        tokenLimit: 32768,
      };

      const config = calculateChunkConfig(model);

      // maxCompletionTokens = min(16000, 32768/4) = 8192 (scaled)
      // availableInputTokens = 128000 - 8192 - 300 = 119508
      // rawChunkSize = 119508 * 4 = 478032, capped at MAX_CHUNK_CHARS
      expect(config.chunkSize).toBe(CHUNK_CONFIG.MAX_CHUNK_CHARS);
      // 128000 / 50000 = 2.56 → 2, clamped to MIN_BATCH_SIZE
      expect(config.batchSize).toBe(CHUNK_CONFIG.MIN_BATCH_SIZE);
      expect(config.maxCompletionTokens).toBe(8192);
      // 32768 * 2 = 65536, capped at MAX_SUMMARY_LENGTH
      expect(config.maxSummaryLength).toBe(CHUNK_CONFIG.MAX_SUMMARY_LENGTH);
    });

    it('should calculate smaller chunk size with lower charsPerToken (CJK content)', () => {
      const model: OpenAIModel = {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        maxLength: 128000,
        tokenLimit: 16000,
      };

      // maxCompletionTokens = 4000, promptOverhead = 300
      // availableInputTokens = 128000 - 4000 - 300 = 123700
      const latinConfig = calculateChunkConfig(model, TOKEN_ESTIMATION.LATIN);
      // rawChunkSize (Latin) = 123700 * 4 = 494800, capped at 400000
      expect(latinConfig.chunkSize).toBe(CHUNK_CONFIG.MAX_CHUNK_CHARS);

      const cjkConfig = calculateChunkConfig(model, TOKEN_ESTIMATION.CJK);
      // rawChunkSize (CJK) = 123700 * 1.5 = 185550 (within bounds)
      expect(cjkConfig.chunkSize).toBe(185550);
    });

    it('should calculate chunk size proportionally with different charsPerToken values', () => {
      const model: OpenAIModel = {
        id: 'small-model',
        name: 'Small Model',
        maxLength: 16000,
        tokenLimit: 4000,
      };

      // maxCompletionTokens = 1000, promptOverhead = 300
      // availableInputTokens = 16000 - 1000 - 300 = 14700

      // With Latin (4 chars/token)
      const latinConfig = calculateChunkConfig(model, TOKEN_ESTIMATION.LATIN);
      // 14700 * 4 = 58800
      expect(latinConfig.chunkSize).toBe(58800);

      // With CJK (1.5 chars/token)
      const cjkConfig = calculateChunkConfig(model, TOKEN_ESTIMATION.CJK);
      // 14700 * 1.5 = 22050
      expect(cjkConfig.chunkSize).toBe(22050);

      // With RTL/Cyrillic (2.5 chars/token)
      const rtlConfig = calculateChunkConfig(
        model,
        TOKEN_ESTIMATION.RTL_CYRILLIC,
      );
      // 14700 * 2.5 = 36750
      expect(rtlConfig.chunkSize).toBe(36750);
    });

    it('should use default charsPerToken when not provided', () => {
      const model: OpenAIModel = {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        maxLength: 128000,
        tokenLimit: 16000,
      };

      const defaultConfig = calculateChunkConfig(model);
      const explicitLatinConfig = calculateChunkConfig(
        model,
        TOKEN_ESTIMATION.LATIN,
      );

      // Should be identical
      expect(defaultConfig.chunkSize).toBe(explicitLatinConfig.chunkSize);
      expect(defaultConfig.batchSize).toBe(explicitLatinConfig.batchSize);
    });
  });

  describe('splitIntoChunks', () => {
    it('should split text into default 50000 character chunks', () => {
      const text = 'A'.repeat(125000);
      const chunks = splitIntoChunks(text);

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(50000);
      expect(chunks[1]).toHaveLength(50000);
      expect(chunks[2]).toHaveLength(25000);
    });

    it('should split text into custom sized chunks', () => {
      const text = 'B'.repeat(10000);
      const chunks = splitIntoChunks(text, 2500);

      expect(chunks).toHaveLength(4);
      expect(chunks[0]).toHaveLength(2500);
      expect(chunks[1]).toHaveLength(2500);
      expect(chunks[2]).toHaveLength(2500);
      expect(chunks[3]).toHaveLength(2500);
    });

    it('should handle text shorter than chunk size', () => {
      const text = 'Short text';
      const chunks = splitIntoChunks(text);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('Short text');
    });

    it('should handle text exactly equal to chunk size', () => {
      const text = 'C'.repeat(50000);
      const chunks = splitIntoChunks(text);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(50000);
    });

    it('should handle empty string', () => {
      const text = '';
      const chunks = splitIntoChunks(text);

      expect(chunks).toHaveLength(0);
    });

    it('should handle text with unicode characters', () => {
      const text = '🎉'.repeat(3000) + 'Hello World 你好世界';
      const chunks = splitIntoChunks(text, 5000);

      expect(chunks.length).toBeGreaterThan(0);
      // Verify all chunks are within size limit
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(5000);
      });
    });

    it('should handle text with newlines and special characters', () => {
      const text = 'Line 1\nLine 2\r\nLine 3\tTabbed\0Null';
      const chunks = splitIntoChunks(text, 20);

      expect(chunks.length).toBeGreaterThan(0);
      // Concatenating all chunks should equal original text
      expect(chunks.join('')).toBe(text);
    });

    it('should preserve content when splitting', () => {
      const text = 'A'.repeat(3000) + 'B'.repeat(3000) + 'C'.repeat(3000);
      const chunks = splitIntoChunks(text, 4000);

      // Joining chunks should recreate original text
      expect(chunks.join('')).toBe(text);
    });

    it('should handle very small chunk sizes', () => {
      const text = 'Hello';
      const chunks = splitIntoChunks(text, 1);

      expect(chunks).toHaveLength(5);
      expect(chunks[0]).toBe('H');
      expect(chunks[1]).toBe('e');
      expect(chunks[2]).toBe('l');
      expect(chunks[3]).toBe('l');
      expect(chunks[4]).toBe('o');
    });

    it('should handle multiline documents', () => {
      const lines = Array(1000).fill('This is a line of text in a document.\n');
      const text = lines.join('');
      const chunks = splitIntoChunks(text, 5000);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join('')).toBe(text);
    });

    it('should split large text into multiple chunks correctly', () => {
      const text = 'X'.repeat(20000);
      const chunks = splitIntoChunks(text, 3000);

      expect(chunks).toHaveLength(7);
      // First 6 chunks should be exactly 3000
      for (let i = 0; i < 6; i++) {
        expect(chunks[i]).toHaveLength(3000);
      }
      // Last chunk should be the remainder
      expect(chunks[6]).toHaveLength(2000);
    });

    it('should handle chunk size larger than text', () => {
      const text = 'Small text';
      const chunks = splitIntoChunks(text, 100000);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });
  });

  describe('summarizeDocumentForQuery', () => {
    const file = new File(['content'], 'test.txt');

    /** A completer that answers each call with the next queued reply. */
    function scriptedCompleter(
      ...replies: Array<string | Error>
    ): TextCompleter & ReturnType<typeof vi.fn> {
      const complete = vi.fn(async () => {
        const reply = replies.shift() ?? 'final summary';
        if (reply instanceof Error) throw reply;
        return reply;
      });
      return complete as unknown as TextCompleter & ReturnType<typeof vi.fn>;
    }

    it('skips loadDocument when preExtractedText is provided', async () => {
      mockLoadDocument.mockClear();
      await summarizeDocumentForQuery({
        file,
        prompt: 'test prompt',
        modelId: 'gpt-4.1',
        complete: scriptedCompleter('chunk summary', 'final summary'),
        preExtractedText: 'pre-extracted content here',
      });
      expect(mockLoadDocument).not.toHaveBeenCalled();
    });

    it('loads the document when no preExtractedText is provided', async () => {
      mockLoadDocument.mockResolvedValue('loaded from file');
      await summarizeDocumentForQuery({
        file,
        prompt: 'test prompt',
        modelId: 'gpt-4.1',
        complete: scriptedCompleter('chunk summary', 'final summary'),
      });
      expect(mockLoadDocument).toHaveBeenCalledWith(file);
    });

    it('summarizes each chunk, then asks for one query-focused summary', async () => {
      const complete = scriptedCompleter('first part', 'second part', 'final');
      const text = 'x'.repeat(CHUNK_CONFIG.DEFAULT_CHUNK_CHARS + 10);

      const summary = await summarizeDocumentForQuery({
        file,
        prompt: 'what changed?',
        modelId: 'not-in-catalog', // default sizing: exactly two chunks
        complete,
        preExtractedText: text,
      });

      expect(summary).toBe('final');
      expect(complete).toHaveBeenCalledTimes(3);
      const finalRequest = complete.mock.calls[2][0];
      expect(finalRequest.userPrompt).toContain('first part');
      expect(finalRequest.userPrompt).toContain('second part');
      expect(finalRequest.userPrompt).toContain('what changed?');
      // The request carries only text fields: no SDK-specific parameters
      // (data_sources, max_completion_tokens) leak out of the summarizer.
      expect(Object.keys(finalRequest).sort()).toEqual([
        'maxTokens',
        'systemPrompt',
        'temperature',
        'userPrompt',
      ]);
    });

    it('keeps going when some chunks fail', async () => {
      const complete = scriptedCompleter(
        new Error('429 rate limited'),
        'second part',
        'final',
      );

      const summary = await summarizeDocumentForQuery({
        file,
        prompt: 'q',
        modelId: 'not-in-catalog',
        complete,
        preExtractedText: 'x'.repeat(CHUNK_CONFIG.DEFAULT_CHUNK_CHARS + 10),
      });

      expect(summary).toBe('final');
      expect(complete.mock.calls[2][0].userPrompt).toContain('second part');
    });

    it('throws the real cause when every chunk fails, without a final call', async () => {
      const notDeployed = new Error(
        '404 The API deployment for this resource does not exist.',
      );
      const complete = scriptedCompleter(notDeployed, notDeployed);

      await expect(
        summarizeDocumentForQuery({
          file,
          prompt: 'q',
          modelId: 'not-in-catalog',
          complete,
          preExtractedText: 'x'.repeat(CHUNK_CONFIG.DEFAULT_CHUNK_CHARS + 10),
        }),
      ).rejects.toBe(notDeployed);
      expect(complete).toHaveBeenCalledTimes(2);
    });

    it('throws when the final summary comes back empty', async () => {
      await expect(
        summarizeDocumentForQuery({
          file,
          prompt: 'q',
          modelId: 'gpt-4.1',
          complete: scriptedCompleter('chunk summary', ''),
          preExtractedText: 'short document',
        }),
      ).rejects.toThrow(/empty document summary/);
    });
  });
});
