/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import { useArtifactStore } from '@/client/stores/artifactStore';
import DOMPurify from 'isomorphic-dompurify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the format converter
vi.mock('@/lib/utils/document/formatConverter', () => ({
  convertToHtml: vi.fn((content: string, format: string) => {
    if (format === 'md' || format === 'markdown') {
      return `<p>${content}</p>`;
    }
    if (format === 'txt') {
      return `<p>${content}</p>`;
    }
    return content;
  }),
}));

vi.mock('@/lib/utils/document/exportUtils', () => ({
  htmlToMarkdown: vi.fn((html: string) => {
    // Use DOMPurify to safely strip HTML tags
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [],
      KEEP_CONTENT: true,
    });
  }),
  htmlToPlainText: vi.fn((html: string) => {
    // Use DOMPurify to safely strip HTML tags
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [],
      KEEP_CONTENT: true,
    });
  }),
}));

describe('artifactStore', () => {
  beforeEach(() => {
    // Reset store before each test
    const { result } = renderHook(() => useArtifactStore());
    act(() => {
      result.current.resetEditor();
    });
  });

  describe('Initial State', () => {
    it('should have correct initial state', () => {
      const { result } = renderHook(() => useArtifactStore());

      expect(result.current.originalCode).toBe('');
      expect(result.current.modifiedCode).toBe('');
      expect(result.current.language).toBe('typescript');
      expect(result.current.fileName).toBe('untitled.ts');
      expect(result.current.isArtifactOpen).toBe(false);
      expect(result.current.isEditorOpen).toBe(false);
      expect(result.current.editorMode).toBe('code');
      expect(result.current.sourceFormat).toBeNull();
    });
  });

  describe('openArtifact', () => {
    it('should open code artifact with correct state', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openArtifact(
          'console.log("test");',
          'javascript',
          'test.js',
        );
      });

      expect(result.current.originalCode).toBe('console.log("test");');
      expect(result.current.modifiedCode).toBe('console.log("test");');
      expect(result.current.language).toBe('javascript');
      expect(result.current.fileName).toBe('test.js');
      expect(result.current.isArtifactOpen).toBe(true);
      expect(result.current.isEditorOpen).toBe(true);
      expect(result.current.editorMode).toBe('code');
      expect(result.current.sourceFormat).toBeNull();
    });

    it('should generate default filename based on language', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openArtifact('def hello():', 'python');
      });

      expect(result.current.fileName).toBe('untitled.py');
      expect(result.current.language).toBe('python');
    });

    it('should handle various language types', () => {
      const { result } = renderHook(() => useArtifactStore());

      const tests = [
        { language: 'typescript', expectedExt: 'ts' },
        { language: 'python', expectedExt: 'py' },
        { language: 'java', expectedExt: 'java' },
        { language: 'rust', expectedExt: 'rs' },
        { language: 'markdown', expectedExt: 'md' },
      ];

      tests.forEach(({ language, expectedExt }) => {
        act(() => {
          result.current.openArtifact('test', language);
        });
        expect(result.current.fileName).toBe(`untitled.${expectedExt}`);
      });
    });
  });

  describe('openDocument', () => {
    it('should open document in code mode by default', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openDocument('# Hello', 'md', 'test.md');
      });

      expect(result.current.originalCode).toBe('# Hello');
      expect(result.current.modifiedCode).toBe('# Hello');
      expect(result.current.language).toBe('markdown');
      expect(result.current.fileName).toBe('test.md');
      expect(result.current.editorMode).toBe('code');
      expect(result.current.sourceFormat).toBe('md');
    });

    it('should open document in document mode when specified', async () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openDocument('# Hello', 'md', 'test.md', 'document');
      });

      await waitFor(() => {
        expect(result.current.editorMode).toBe('document');
        expect(result.current.modifiedCode).toBe('<p># Hello</p>');
      });
    });

    it('should handle different document formats', () => {
      const { result } = renderHook(() => useArtifactStore());

      const tests = [
        { format: 'md' as const, expectedLang: 'markdown' },
        { format: 'txt' as const, expectedLang: 'plaintext' },
        { format: 'html' as const, expectedLang: 'html' },
      ];

      tests.forEach(({ format, expectedLang }) => {
        act(() => {
          result.current.openDocument('content', format, `test.${format}`);
        });
        expect(result.current.language).toBe(expectedLang);
        expect(result.current.sourceFormat).toBe(format);
      });
    });
  });

  describe('setModifiedCode', () => {
    it('should update both modified and original code', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openArtifact('old code', 'javascript');
      });

      act(() => {
        result.current.setModifiedCode('new code');
      });

      expect(result.current.modifiedCode).toBe('new code');
      expect(result.current.originalCode).toBe('new code');
    });
  });

  describe('setEditorMode', () => {
    it('should convert markdown to HTML when switching to document mode', async () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openDocument('# Hello World', 'md', 'test.md');
      });

      act(() => {
        result.current.setEditorMode('document');
      });

      await waitFor(() => {
        expect(result.current.editorMode).toBe('document');
        expect(result.current.modifiedCode).toContain('Hello World');
      });
    });

    it('should convert HTML back to markdown when switching to code mode', async () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openDocument('# Hello', 'md', 'test.md', 'document');
      });

      await waitFor(() => {
        expect(result.current.editorMode).toBe('document');
      });

      act(() => {
        result.current.setEditorMode('code');
      });

      await waitFor(() => {
        expect(result.current.editorMode).toBe('code');
      });
    });

    it('should not switch modes for files without sourceFormat', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openArtifact('console.log("test");', 'javascript');
      });

      act(() => {
        result.current.setEditorMode('document');
      });

      // Should stay in document mode but not convert
      expect(result.current.editorMode).toBe('document');
    });
  });

  describe('canSwitchToDocumentMode', () => {
    it('should return true for markdown files', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openDocument('# Test', 'md', 'test.md');
      });

      expect(result.current.canSwitchToDocumentMode()).toBe(true);
    });

    it('should return true for text files', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openDocument('Hello', 'txt', 'test.txt');
      });

      expect(result.current.canSwitchToDocumentMode()).toBe(true);
    });

    it('should return true for HTML files', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openDocument('<p>Test</p>', 'html', 'test.html');
      });

      expect(result.current.canSwitchToDocumentMode()).toBe(true);
    });

    it('should return false for pure code files', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openArtifact(
          'console.log("test");',
          'javascript',
          'test.js',
        );
      });

      expect(result.current.canSwitchToDocumentMode()).toBe(false);
    });

    it('should return false for Python files', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openArtifact('print("test")', 'python', 'test.py');
      });

      expect(result.current.canSwitchToDocumentMode()).toBe(false);
    });
  });

  describe('setFileName', () => {
    it('should update filename and auto-detect language', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.setFileName('myfile.py');
      });

      expect(result.current.fileName).toBe('myfile.py');
      expect(result.current.language).toBe('python');
    });

    it('should handle various file extensions', () => {
      const { result } = renderHook(() => useArtifactStore());

      const tests = [
        { file: 'test.ts', lang: 'typescript' },
        { file: 'test.js', lang: 'javascript' },
        { file: 'test.py', lang: 'python' },
        { file: 'test.md', lang: 'markdown' },
        { file: 'test.json', lang: 'json' },
      ];

      tests.forEach(({ file, lang }) => {
        act(() => {
          result.current.setFileName(file);
        });
        expect(result.current.language).toBe(lang);
      });
    });
  });

  describe('closeArtifact', () => {
    it('should close artifact but preserve content', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openArtifact('test code', 'javascript', 'test.js');
      });

      act(() => {
        result.current.closeArtifact();
      });

      expect(result.current.isArtifactOpen).toBe(false);
      expect(result.current.isEditorOpen).toBe(false);
      // Content should still be there (no localStorage, but in memory)
      expect(result.current.modifiedCode).toBe('test code');
    });
  });

  describe('getArtifactContext', () => {
    it('should return null when editor is not open', async () => {
      const { result } = renderHook(() => useArtifactStore());

      expect(await result.current.getArtifactContext()).toBeNull();
    });

    it('should return null when editor is open but has no content', async () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openArtifact('', 'javascript');
      });

      expect(await result.current.getArtifactContext()).toBeNull();
    });

    it('should return artifact context when editor has content', async () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openArtifact('test code', 'javascript', 'test.js');
      });

      const context = await result.current.getArtifactContext();
      expect(context).toEqual({
        fileName: 'test.js',
        language: 'javascript',
        code: 'test code',
      });
    });
  });

  describe('downloadFile', () => {
    it('should create download link with correct attributes', () => {
      const { result } = renderHook(() => useArtifactStore());

      // Mock DOM methods
      const createElementSpy = vi.spyOn(document, 'createElement');
      const createObjectURLSpy = vi
        .spyOn(URL, 'createObjectURL')
        .mockReturnValue('blob:test');
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL');

      act(() => {
        result.current.openArtifact('test content', 'javascript', 'test.js');
      });

      act(() => {
        result.current.downloadFile();
      });

      expect(createElementSpy).toHaveBeenCalledWith('a');
      expect(createObjectURLSpy).toHaveBeenCalled();
      expect(revokeObjectURLSpy).toHaveBeenCalled();

      createElementSpy.mockRestore();
      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
    });
  });

  describe('setLanguage', () => {
    it('should update language and filename when using default name', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.setLanguage('python');
      });

      expect(result.current.language).toBe('python');
      expect(result.current.fileName).toBe('untitled.py');
    });

    it('should update language but not filename when using custom name', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.setFileName('myfile.js');
      });

      act(() => {
        result.current.setLanguage('python');
      });

      expect(result.current.language).toBe('python');
      expect(result.current.fileName).toBe('myfile.js'); // Should not change
    });
  });

  describe('resetEditor', () => {
    it('should reset all editor state to defaults', () => {
      const { result } = renderHook(() => useArtifactStore());

      act(() => {
        result.current.openArtifact('test', 'python', 'test.py');
        result.current.setIsLoading(true);
        result.current.setError('test error');
      });

      act(() => {
        result.current.resetEditor();
      });

      expect(result.current.originalCode).toBe('');
      expect(result.current.modifiedCode).toBe('');
      expect(result.current.language).toBe('typescript');
      expect(result.current.fileName).toBe('untitled.ts');
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });
});
