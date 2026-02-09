import { CHUNK_CONFIG } from '@/lib/utils/app/const';
import {
  calculateChunkConfig,
  splitIntoChunks,
} from '@/lib/utils/app/stream/documentSummary';

import { OpenAIModel } from '@/types/openai';

import { describe, expect, it } from 'vitest';

describe('Document Summary Utilities', () => {
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

      // With 128K context, should calculate larger chunks
      // (128000 - 1000) / 10 * 4 = 50800, but capped at MAX_CHUNK_CHARS
      expect(config.chunkSize).toBe(CHUNK_CONFIG.MAX_CHUNK_CHARS);
      // 128000 / 20000 = 6.4 → 6, clamped to max 10
      expect(config.batchSize).toBe(6);
      // min(5000, 16000 / 4) = 4000
      expect(config.maxCompletionTokens).toBe(4000);
      // 16000 * 2 = 32000, clamped to 16K-64K range
      expect(config.maxSummaryLength).toBe(32000);
    });

    it('should calculate larger values for o3 model with extended context', () => {
      const model: OpenAIModel = {
        id: 'o3',
        name: 'o3',
        maxLength: 200000,
        tokenLimit: 100000,
      };

      const config = calculateChunkConfig(model);

      // With 200K context, chunk size hits max
      expect(config.chunkSize).toBe(CHUNK_CONFIG.MAX_CHUNK_CHARS);
      // 200000 / 20000 = 10, clamped to max
      expect(config.batchSize).toBe(CHUNK_CONFIG.MAX_BATCH_SIZE);
      // min(5000, 100000 / 4) = 5000
      expect(config.maxCompletionTokens).toBe(5000);
      // 100000 * 2 = 200000, but capped at MAX_SUMMARY_LENGTH
      expect(config.maxSummaryLength).toBe(CHUNK_CONFIG.MAX_SUMMARY_LENGTH);
    });

    it('should calculate smaller values for a model with limited context', () => {
      const model: OpenAIModel = {
        id: 'small-model',
        name: 'Small Model',
        maxLength: 16000,
        tokenLimit: 4000,
      };

      const config = calculateChunkConfig(model);

      // (16000 - 1000) / 10 * 4 = 6000
      expect(config.chunkSize).toBe(6000);
      // 16000 / 20000 = 0.8 → 0, clamped to MIN_BATCH_SIZE
      expect(config.batchSize).toBe(CHUNK_CONFIG.MIN_BATCH_SIZE);
      // min(5000, 4000 / 4) = 1000
      expect(config.maxCompletionTokens).toBe(1000);
      // 4000 * 2 = 8000, but clamped to MIN_SUMMARY_LENGTH
      expect(config.maxSummaryLength).toBe(CHUNK_CONFIG.MIN_SUMMARY_LENGTH);
    });

    it('should respect minimum bounds for very small context windows', () => {
      const model: OpenAIModel = {
        id: 'tiny-model',
        name: 'Tiny Model',
        maxLength: 4000,
        tokenLimit: 1000,
      };

      const config = calculateChunkConfig(model);

      // (4000 - 1000) / 10 * 4 = 1200, clamped to MIN_CHUNK_CHARS
      expect(config.chunkSize).toBe(CHUNK_CONFIG.MIN_CHUNK_CHARS);
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

      // Large context = max chunk size
      expect(config.chunkSize).toBe(CHUNK_CONFIG.MAX_CHUNK_CHARS);
      // 200000 / 20000 = 10
      expect(config.batchSize).toBe(CHUNK_CONFIG.MAX_BATCH_SIZE);
      // min(5000, 64000 / 4) = 5000
      expect(config.maxCompletionTokens).toBe(5000);
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

      expect(config.chunkSize).toBe(CHUNK_CONFIG.MAX_CHUNK_CHARS);
      expect(config.batchSize).toBe(6);
      expect(config.maxCompletionTokens).toBe(5000);
      // 32768 * 2 = 65536, capped at MAX_SUMMARY_LENGTH
      expect(config.maxSummaryLength).toBe(CHUNK_CONFIG.MAX_SUMMARY_LENGTH);
    });
  });

  describe('splitIntoChunks', () => {
    it('should split text into default 6000 character chunks', () => {
      const text = 'A'.repeat(15000);
      const chunks = splitIntoChunks(text);

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(6000);
      expect(chunks[1]).toHaveLength(6000);
      expect(chunks[2]).toHaveLength(3000);
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
      const text = 'C'.repeat(6000);
      const chunks = splitIntoChunks(text);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(6000);
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
});
