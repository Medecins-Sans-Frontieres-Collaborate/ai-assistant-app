import { splitIntoChunks } from '@/lib/utils/app/stream/documentSummary';

import { describe, expect, it } from 'vitest';

describe('Document Summary Utilities', () => {
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
