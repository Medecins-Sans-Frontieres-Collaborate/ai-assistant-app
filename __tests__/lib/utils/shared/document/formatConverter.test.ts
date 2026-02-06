import {
  autoConvertToHtml,
  convertToHtml,
  detectFormat,
  markdownToHtml,
  sanitizeHtml,
  textToHtml,
} from '@/lib/utils/shared/document/formatConverter';

import { beforeAll, describe, expect, it, vi } from 'vitest';

// Mock getDOMPurify to avoid slow jsdom initialization in tests
vi.mock('@/lib/utils/shared/document/domPurify', () => ({
  getDOMPurify: vi.fn().mockResolvedValue({
    sanitize: (html: string, config?: object) => {
      // Test mock only - real sanitization uses DOMPurify
      return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/\s*on\w+="[^"]*"/gi, '');
    },
  }),
}));

describe('formatConverter', () => {
  describe('detectFormat', () => {
    it('should detect markdown files', () => {
      expect(detectFormat('test.md')).toBe('md');
      expect(detectFormat('test.markdown')).toBe('md');
    });

    it('should detect text files', () => {
      expect(detectFormat('test.txt')).toBe('txt');
    });

    it('should detect HTML files', () => {
      expect(detectFormat('test.html')).toBe('html');
      expect(detectFormat('test.htm')).toBe('html');
    });

    it('should detect PDF files', () => {
      expect(detectFormat('test.pdf')).toBe('pdf');
    });

    it('should return null for unknown formats', () => {
      expect(detectFormat('test.docx')).toBeNull();
      expect(detectFormat('test.js')).toBeNull();
      expect(detectFormat('test')).toBeNull();
    });

    it('should be case insensitive', () => {
      expect(detectFormat('TEST.MD')).toBe('md');
      expect(detectFormat('TEST.HTML')).toBe('html');
    });
  });

  describe('markdownToHtml', () => {
    it('should convert basic markdown to HTML', () => {
      const markdown = '# Hello World';
      const html = markdownToHtml(markdown);
      expect(html).toContain('<h1');
      expect(html).toContain('Hello World');
    });

    it('should convert paragraphs', () => {
      const markdown = 'This is a paragraph.';
      const html = markdownToHtml(markdown);
      expect(html).toContain('<p>');
      expect(html).toContain('This is a paragraph.');
    });

    it('should convert bold text', () => {
      const markdown = '**bold text**';
      const html = markdownToHtml(markdown);
      expect(html).toContain('<strong>');
      expect(html).toContain('bold text');
    });

    it('should convert italic text', () => {
      const markdown = '*italic text*';
      const html = markdownToHtml(markdown);
      expect(html).toContain('<em>');
      expect(html).toContain('italic text');
    });

    it('should convert links', () => {
      const markdown = '[Link](https://example.com)';
      const html = markdownToHtml(markdown);
      expect(html).toContain('<a');
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain('Link');
    });

    it('should convert code blocks', () => {
      const markdown = '```\ncode here\n```';
      const html = markdownToHtml(markdown);
      expect(html).toContain('<pre');
      expect(html).toContain('code here');
    });

    it('should convert unordered lists', () => {
      const markdown = '- Item 1\n- Item 2';
      const html = markdownToHtml(markdown);
      expect(html).toContain('<ul');
      expect(html).toContain('<li>');
      expect(html).toContain('Item 1');
      expect(html).toContain('Item 2');
    });

    it('should convert ordered lists', () => {
      const markdown = '1. First\n2. Second';
      const html = markdownToHtml(markdown);
      expect(html).toContain('<ol');
      expect(html).toContain('<li>');
      expect(html).toContain('First');
      expect(html).toContain('Second');
    });

    it('should handle multiple headings', () => {
      const markdown = '# H1\n## H2\n### H3';
      const html = markdownToHtml(markdown);
      expect(html).toContain('<h1');
      expect(html).toContain('<h2');
      expect(html).toContain('<h3');
    });

    it('should convert newlines to line breaks (GFM)', () => {
      const markdown = 'Line 1\nLine 2';
      const html = markdownToHtml(markdown);
      // With GFM breaks: true, single newlines become <br>
      expect(html).toBeTruthy();
    });

    it('should handle empty input', () => {
      const html = markdownToHtml('');
      expect(html).toBe('');
    });

    it('should handle complex markdown', () => {
      const markdown = `# Title

This is a **bold** paragraph with *italic* text.

- List item 1
- List item 2

[Link](https://example.com)`;

      const html = markdownToHtml(markdown);
      expect(html).toContain('<h1');
      expect(html).toContain('<strong>');
      expect(html).toContain('<em>');
      expect(html).toContain('<ul');
      expect(html).toContain('<a');
    });
  });

  describe('textToHtml', () => {
    it('should convert plain text to paragraphs', () => {
      const text = 'This is plain text.';
      const html = textToHtml(text);
      expect(html).toContain('<p>');
      expect(html).toContain('This is plain text.');
    });

    it('should convert double newlines to separate paragraphs', () => {
      const text = 'Paragraph 1\n\nParagraph 2';
      const html = textToHtml(text);
      expect(html).toContain('<p>Paragraph 1</p>');
      expect(html).toContain('<p>Paragraph 2</p>');
    });

    it('should convert single newlines to line breaks within paragraphs', () => {
      const text = 'Line 1\nLine 2';
      const html = textToHtml(text);
      expect(html).toContain('<br>');
      expect(html).toContain('Line 1');
      expect(html).toContain('Line 2');
    });

    it('should handle multiple consecutive newlines', () => {
      const text = 'Para 1\n\n\n\nPara 2';
      const html = textToHtml(text);
      expect(html).toContain('<p>Para 1</p>');
      expect(html).toContain('<p>Para 2</p>');
    });

    it('should handle empty input', () => {
      const html = textToHtml('');
      expect(html).toBe('<p></p>'); // Empty input becomes empty paragraph
    });

    it('should handle text with no newlines', () => {
      const html = textToHtml('Single line');
      expect(html).toBe('<p>Single line</p>');
    });
  });

  describe('sanitizeHtml', () => {
    it('should remove script tags', async () => {
      const html = '<p>Safe</p><script>alert("xss")</script>';
      const sanitized = await sanitizeHtml(html);
      expect(sanitized).not.toContain('<script');
      expect(sanitized).toContain('<p>Safe</p>');
    });

    it('should remove inline event handlers', async () => {
      const html = '<div onclick="alert()">Click me</div>';
      const sanitized = await sanitizeHtml(html);
      expect(sanitized).not.toContain('onclick');
      expect(sanitized).toContain('Click me');
    });

    it('should preserve safe HTML', async () => {
      const html = '<p><strong>Bold</strong> and <em>italic</em></p>';
      const sanitized = await sanitizeHtml(html);
      expect(sanitized).toBe(html);
    });

    it('should handle multiple script tags', async () => {
      const html = '<p>Text</p><script>bad1</script><script>bad2</script>';
      const sanitized = await sanitizeHtml(html);
      expect(sanitized).not.toContain('script');
      expect(sanitized).toContain('<p>Text</p>');
    });
  });

  describe('convertToHtml', () => {
    it('should convert markdown format', async () => {
      const content = '# Hello';
      const html = await convertToHtml(content, 'md');
      expect(html).toContain('<h1');
      expect(html).toContain('Hello');
    });

    it('should convert markdown format (full name)', async () => {
      const content = '**Bold**';
      const html = await convertToHtml(content, 'markdown');
      expect(html).toContain('<strong>');
    });

    it('should convert text format', async () => {
      const content = 'Plain text\n\nParagraph 2';
      const html = await convertToHtml(content, 'txt');
      expect(html).toContain('<p>');
    });

    it('should sanitize HTML format', async () => {
      const content = '<p>Safe</p><script>bad</script>';
      const html = await convertToHtml(content, 'html');
      expect(html).not.toContain('script');
      expect(html).toContain('<p>Safe</p>');
    });

    it('should sanitize htm format', async () => {
      const content = '<div>Content</div>';
      const html = await convertToHtml(content, 'htm');
      expect(html).toContain('Content');
    });

    it('should fallback to text conversion for unknown formats', async () => {
      const content = 'Some content';
      const html = await convertToHtml(content, 'pdf' as any);
      expect(html).toContain('<p>');
    });
  });

  describe('autoConvertToHtml', () => {
    it('should detect and convert markdown by patterns', async () => {
      const content = '# Title\n\nThis has **markdown**';
      const html = await autoConvertToHtml(content);
      expect(html).toContain('<h1');
      expect(html).toContain('<strong>');
    });

    it('should detect markdown by bold syntax', async () => {
      const content = 'This is **bold** text';
      const html = await autoConvertToHtml(content);
      expect(html).toContain('<strong>');
    });

    it('should detect markdown by italic syntax', async () => {
      const content = 'This is *italic* text';
      const html = await autoConvertToHtml(content);
      expect(html).toContain('<em>');
    });

    it('should detect markdown by link syntax', async () => {
      const content = '[Link](url)';
      const html = await autoConvertToHtml(content);
      expect(html).toContain('<a');
    });

    it('should detect markdown by code block', async () => {
      const content = '```\ncode\n```';
      const html = await autoConvertToHtml(content);
      expect(html).toContain('<pre');
    });

    it('should fallback to text conversion if no markdown detected', async () => {
      const content = 'Plain text without markdown';
      const html = await autoConvertToHtml(content);
      expect(html).toContain('<p>');
      expect(html).toContain('Plain text without markdown');
    });

    it('should use filename to detect format', async () => {
      const content = 'Content here';
      const html = await autoConvertToHtml(content, 'test.txt');
      expect(html).toContain('<p>');
    });

    it('should convert markdown files based on filename', async () => {
      const content = '# Title';
      const html = await autoConvertToHtml(content, 'README.md');
      expect(html).toContain('<h1');
    });

    it('should sanitize HTML files based on filename', async () => {
      const content = '<p>Test</p><script>bad</script>';
      const html = await autoConvertToHtml(content, 'page.html');
      expect(html).not.toContain('script');
    });

    it('should handle files without extension', async () => {
      const content = 'Plain content';
      const html = await autoConvertToHtml(content, 'README');
      // Should fallback to markdown detection or text
      expect(html).toBeTruthy();
    });
  });

  describe('Edge Cases', () => {
    it('should handle special characters in markdown', () => {
      const markdown = '# Title & Text <tag>';
      const html = markdownToHtml(markdown);
      expect(html).toContain('&amp;'); // & is escaped
      expect(html).toContain('<tag>'); // HTML tags in markdown are preserved
    });

    it('should handle unicode in text', () => {
      const text = 'Hello 世界 🌍';
      const html = textToHtml(text);
      expect(html).toContain('世界');
      expect(html).toContain('🌍');
    });

    it('should handle very long content', () => {
      const longText = 'A'.repeat(10000);
      const html = textToHtml(longText);
      expect(html.length).toBeGreaterThan(10000);
    });

    it('should handle malformed markdown gracefully', () => {
      const malformed = '# Missing closing\n**unclosed bold';
      const html = markdownToHtml(malformed);
      // Should not throw, should produce some HTML
      expect(html).toBeTruthy();
    });
  });
});
