import { extractCitationsFromContent } from '@/lib/utils/app/stream/citation';

import { describe, expect, it, vi } from 'vitest';

describe('Citation Utilities', () => {
  describe('extractCitationsFromContent', () => {
    it('should extract citations using metadata format', () => {
      const content = `This is some text content.

<<<METADATA_START>>>{"citations":[{"title":"Test Source","url":"https://example.com","date":"2024-01-01","number":1}]}<<<METADATA_END>>>`;

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe('This is some text content.');
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0]).toEqual({
        title: 'Test Source',
        url: 'https://example.com',
        date: '2024-01-01',
        number: 1,
      });
      expect(result.extractionMethod).toBe('metadata');
    });

    it('should handle multiple citations in metadata format', () => {
      const content = `Research shows that AI is advancing.

<<<METADATA_START>>>{"citations":[
  {"title":"Source 1","url":"https://source1.com","date":"2024-01-01","number":1},
  {"title":"Source 2","url":"https://source2.com","date":"2024-01-02","number":2},
  {"title":"Source 3","url":"https://source3.com","date":"2024-01-03","number":3}
]}<<<METADATA_END>>>`;

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe('Research shows that AI is advancing.');
      expect(result.citations).toHaveLength(3);
      expect(result.citations[0].title).toBe('Source 1');
      expect(result.citations[1].title).toBe('Source 2');
      expect(result.citations[2].title).toBe('Source 3');
      expect(result.extractionMethod).toBe('metadata');
    });

    it('should return empty citations array when no citations found', () => {
      const content = 'Just some regular text without citations.';

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe(content);
      expect(result.citations).toEqual([]);
      expect(result.extractionMethod).toBe('none');
    });

    it('should handle malformed JSON in metadata format gracefully', () => {
      const content = `Text content.

<<<METADATA_START>>>{invalid json}<<<METADATA_END>>>`;

      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe('Text content.');
      expect(result.citations).toEqual([]);
      expect(result.extractionMethod).toBe('metadata');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error parsing metadata JSON:',
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });

    it('should handle JSON without citations field in metadata format', () => {
      const content = `Text content.

<<<METADATA_START>>>{"other":"data"}<<<METADATA_END>>>`;

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe('Text content.');
      expect(result.citations).toEqual([]);
      expect(result.extractionMethod).toBe('metadata');
    });

    it('should preserve whitespace in text content', () => {
      const content = `Text with   multiple    spaces.

<<<METADATA_START>>>{"citations":[]}<<<METADATA_END>>>`;

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe('Text with   multiple    spaces.');
    });

    it('should handle empty string content', () => {
      const content = '';

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe('');
      expect(result.citations).toEqual([]);
      expect(result.extractionMethod).toBe('none');
    });

    it('should handle citations with special characters', () => {
      const content = `Text.

<<<METADATA_START>>>{"citations":[{"title":"Test & Co.","url":"https://example.com?foo=bar&baz=qux","date":"2024-01-01","number":1}]}<<<METADATA_END>>>`;

      const result = extractCitationsFromContent(content);

      expect(result.citations[0].title).toBe('Test & Co.');
      expect(result.citations[0].url).toContain('foo=bar&baz=qux');
      expect(result.extractionMethod).toBe('metadata');
    });

    it('should handle unicode characters in content and citations', () => {
      const content = `Text with émojis 🎉 and symbols ∑.

<<<METADATA_START>>>{"citations":[{"title":"Tëst Søurçe","url":"https://example.com","date":"2024-01-01","number":1}]}<<<METADATA_END>>>`;

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe('Text with émojis 🎉 and symbols ∑.');
      expect(result.citations[0].title).toBe('Tëst Søurçe');
      expect(result.extractionMethod).toBe('metadata');
    });

    it('should handle newlines and multiline text', () => {
      const content = `First line.
Second line.
Third line.

<<<METADATA_START>>>{"citations":[{"title":"Test","url":"https://test.com"}]}<<<METADATA_END>>>`;

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe(`First line.
Second line.
Third line.`);
    });

    it('should handle very long content strings', () => {
      const longText = 'A'.repeat(10000);
      const content = `${longText}

<<<METADATA_START>>>{"citations":[{"title":"Test","url":"https://test.com"}]}<<<METADATA_END>>>`;

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe(longText);
      expect(result.citations).toHaveLength(1);
    });

    it('should extract threadId from metadata', () => {
      const content = `Response text.

<<<METADATA_START>>>{"citations":[{"title":"Test","url":"https://test.com"}],"threadId":"thread-123"}<<<METADATA_END>>>`;

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe('Response text.');
      expect(result.citations).toHaveLength(1);
      expect(result.extractionMethod).toBe('metadata');
    });

    it('should extract thinking from metadata', () => {
      const content = `Response text.

<<<METADATA_START>>>{"thinking":"Some reasoning","citations":[]}<<<METADATA_END>>>`;

      const result = extractCitationsFromContent(content);

      expect(result.text).toBe('Response text.');
      expect(result.extractionMethod).toBe('metadata');
    });
  });
});
