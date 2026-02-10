import {
  getCachedTextPath,
  shouldCacheText,
} from '@/lib/utils/server/file/textCacheUtils';

import { describe, expect, it } from 'vitest';

describe('Text Caching Utilities', () => {
  describe('shouldCacheText', () => {
    it('should return true for PDF files', () => {
      expect(shouldCacheText('document.pdf')).toBe(true);
      expect(shouldCacheText('DOCUMENT.PDF')).toBe(true);
      expect(shouldCacheText('my.document.pdf')).toBe(true);
    });

    it('should return true for DOCX files', () => {
      expect(shouldCacheText('document.docx')).toBe(true);
      expect(shouldCacheText('DOCUMENT.DOCX')).toBe(true);
    });

    it('should return true for XLSX files', () => {
      expect(shouldCacheText('spreadsheet.xlsx')).toBe(true);
      expect(shouldCacheText('SPREADSHEET.XLSX')).toBe(true);
    });

    it('should return true for PPTX files', () => {
      expect(shouldCacheText('presentation.pptx')).toBe(true);
      expect(shouldCacheText('PRESENTATION.PPTX')).toBe(true);
    });

    it('should return true for EPUB files', () => {
      expect(shouldCacheText('book.epub')).toBe(true);
      expect(shouldCacheText('BOOK.EPUB')).toBe(true);
    });

    it('should return false for plain text files', () => {
      expect(shouldCacheText('readme.txt')).toBe(false);
      expect(shouldCacheText('README.TXT')).toBe(false);
    });

    it('should return false for code files', () => {
      expect(shouldCacheText('script.py')).toBe(false);
      expect(shouldCacheText('code.js')).toBe(false);
      expect(shouldCacheText('query.sql')).toBe(false);
    });

    it('should return false for JSON files', () => {
      expect(shouldCacheText('data.json')).toBe(false);
    });

    it('should return false for CSV files', () => {
      expect(shouldCacheText('data.csv')).toBe(false);
    });

    it('should return false for files without extension', () => {
      expect(shouldCacheText('README')).toBe(false);
      expect(shouldCacheText('Makefile')).toBe(false);
    });

    it('should return false for image files', () => {
      expect(shouldCacheText('photo.jpg')).toBe(false);
      expect(shouldCacheText('image.png')).toBe(false);
    });
  });

  describe('getCachedTextPath', () => {
    it('should append .cached.txt to the original path', () => {
      const originalPath = 'user123/uploads/files/abc123.pdf';
      const cachedPath = getCachedTextPath(originalPath);
      expect(cachedPath).toBe('user123/uploads/files/abc123.pdf.cached.txt');
    });

    it('should work with various file extensions', () => {
      expect(getCachedTextPath('path/to/file.docx')).toBe(
        'path/to/file.docx.cached.txt',
      );
      expect(getCachedTextPath('path/to/file.xlsx')).toBe(
        'path/to/file.xlsx.cached.txt',
      );
      expect(getCachedTextPath('path/to/file.pptx')).toBe(
        'path/to/file.pptx.cached.txt',
      );
    });

    it('should handle paths without directories', () => {
      expect(getCachedTextPath('document.pdf')).toBe('document.pdf.cached.txt');
    });

    it('should handle deeply nested paths', () => {
      expect(getCachedTextPath('a/b/c/d/e/file.epub')).toBe(
        'a/b/c/d/e/file.epub.cached.txt',
      );
    });
  });
});
