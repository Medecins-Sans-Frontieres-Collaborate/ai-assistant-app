import { useArtifactStore } from '@/client/stores/artifactStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the format converter (dynamically imported by setEditorMode / openDocument)
vi.mock('@/lib/utils/shared/document/formatConverter', () => ({
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

// Mock export utils (dynamically imported by setEditorMode, statically by getArtifactContext)
vi.mock('@/lib/utils/shared/document/exportUtils', () => ({
  htmlToMarkdown: vi.fn((html: string) => {
    // Simple HTML tag stripping for test purposes
    return html.replace(/<[^>]*>/g, '');
  }),
  htmlToPlainText: vi.fn((html: string) => {
    return html.replace(/<[^>]*>/g, '');
  }),
}));

describe('artifactStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useArtifactStore.getState().resetEditor();
  });

  describe('Initial State', () => {
    it('should have correct initial state', () => {
      const state = useArtifactStore.getState();

      expect(state.originalCode).toBe('');
      expect(state.modifiedCode).toBe('');
      expect(state.language).toBe('typescript');
      expect(state.fileName).toBe('untitled.ts');
      expect(state.isArtifactOpen).toBe(false);
      expect(state.isEditorOpen).toBe(false);
      expect(state.editorMode).toBe('code');
      expect(state.sourceFormat).toBeNull();
    });
  });

  describe('openArtifact', () => {
    it('should open code artifact with correct state', () => {
      useArtifactStore
        .getState()
        .openArtifact('console.log("test");', 'javascript', 'test.js');

      const state = useArtifactStore.getState();
      expect(state.originalCode).toBe('console.log("test");');
      expect(state.modifiedCode).toBe('console.log("test");');
      expect(state.language).toBe('javascript');
      expect(state.fileName).toBe('test.js');
      expect(state.isArtifactOpen).toBe(true);
      expect(state.isEditorOpen).toBe(true);
      expect(state.editorMode).toBe('code');
      expect(state.sourceFormat).toBeNull();
    });

    it('should generate default filename based on language', () => {
      useArtifactStore.getState().openArtifact('def hello():', 'python');

      const state = useArtifactStore.getState();
      expect(state.fileName).toBe('untitled.py');
      expect(state.language).toBe('python');
    });

    it('should handle various language types', () => {
      const tests = [
        { language: 'typescript', expectedExt: 'ts' },
        { language: 'python', expectedExt: 'py' },
        { language: 'java', expectedExt: 'java' },
        { language: 'rust', expectedExt: 'rs' },
        { language: 'markdown', expectedExt: 'md' },
      ];

      tests.forEach(({ language, expectedExt }) => {
        useArtifactStore.getState().openArtifact('test', language);
        expect(useArtifactStore.getState().fileName).toBe(
          `untitled.${expectedExt}`,
        );
      });
    });
  });

  describe('openDocument', () => {
    it('should open document in code mode by default', () => {
      useArtifactStore.getState().openDocument('# Hello', 'md', 'test.md');

      const state = useArtifactStore.getState();
      expect(state.originalCode).toBe('# Hello');
      expect(state.modifiedCode).toBe('# Hello');
      expect(state.language).toBe('markdown');
      expect(state.fileName).toBe('test.md');
      expect(state.editorMode).toBe('code');
      expect(state.sourceFormat).toBe('md');
    });

    it('should open document in document mode when specified', async () => {
      useArtifactStore
        .getState()
        .openDocument('# Hello', 'md', 'test.md', 'document');

      await vi.waitFor(() => {
        expect(useArtifactStore.getState().editorMode).toBe('document');
        expect(useArtifactStore.getState().modifiedCode).toBe('<p># Hello</p>');
      });
    });

    it('should handle different document formats', () => {
      const tests = [
        { format: 'md' as const, expectedLang: 'markdown' },
        { format: 'txt' as const, expectedLang: 'plaintext' },
        { format: 'html' as const, expectedLang: 'html' },
      ];

      tests.forEach(({ format, expectedLang }) => {
        useArtifactStore
          .getState()
          .openDocument('content', format, `test.${format}`);
        expect(useArtifactStore.getState().language).toBe(expectedLang);
        expect(useArtifactStore.getState().sourceFormat).toBe(format);
      });
    });
  });

  describe('setModifiedCode', () => {
    it('should update both modified and original code', () => {
      useArtifactStore.getState().openArtifact('old code', 'javascript');
      useArtifactStore.getState().setModifiedCode('new code');

      const state = useArtifactStore.getState();
      expect(state.modifiedCode).toBe('new code');
      expect(state.originalCode).toBe('new code');
    });
  });

  describe('setEditorMode', () => {
    it('should convert markdown to HTML when switching to document mode', async () => {
      useArtifactStore
        .getState()
        .openDocument('# Hello World', 'md', 'test.md');
      useArtifactStore.getState().setEditorMode('document');

      await vi.waitFor(() => {
        expect(useArtifactStore.getState().editorMode).toBe('document');
        expect(useArtifactStore.getState().modifiedCode).toContain(
          'Hello World',
        );
      });
    });

    it('should convert HTML back to markdown when switching to code mode', async () => {
      useArtifactStore
        .getState()
        .openDocument('# Hello', 'md', 'test.md', 'document');

      await vi.waitFor(() => {
        expect(useArtifactStore.getState().editorMode).toBe('document');
      });

      useArtifactStore.getState().setEditorMode('code');

      await vi.waitFor(() => {
        expect(useArtifactStore.getState().editorMode).toBe('code');
      });
    });

    it('should not switch modes for files without sourceFormat', () => {
      useArtifactStore
        .getState()
        .openArtifact('console.log("test");', 'javascript');
      useArtifactStore.getState().setEditorMode('document');

      // Should stay in document mode but not convert
      expect(useArtifactStore.getState().editorMode).toBe('document');
    });
  });

  describe('canSwitchToDocumentMode', () => {
    it('should return true for markdown files', () => {
      useArtifactStore.getState().openDocument('# Test', 'md', 'test.md');

      expect(useArtifactStore.getState().canSwitchToDocumentMode()).toBe(true);
    });

    it('should return true for text files', () => {
      useArtifactStore.getState().openDocument('Hello', 'txt', 'test.txt');

      expect(useArtifactStore.getState().canSwitchToDocumentMode()).toBe(true);
    });

    it('should return true for HTML files', () => {
      useArtifactStore
        .getState()
        .openDocument('<p>Test</p>', 'html', 'test.html');

      expect(useArtifactStore.getState().canSwitchToDocumentMode()).toBe(true);
    });

    it('should return false for pure code files', () => {
      useArtifactStore
        .getState()
        .openArtifact('console.log("test");', 'javascript', 'test.js');

      expect(useArtifactStore.getState().canSwitchToDocumentMode()).toBe(false);
    });

    it('should return false for Python files', () => {
      useArtifactStore
        .getState()
        .openArtifact('print("test")', 'python', 'test.py');

      expect(useArtifactStore.getState().canSwitchToDocumentMode()).toBe(false);
    });
  });

  describe('setFileName', () => {
    it('should update filename and auto-detect language', () => {
      useArtifactStore.getState().setFileName('myfile.py');

      const state = useArtifactStore.getState();
      expect(state.fileName).toBe('myfile.py');
      expect(state.language).toBe('python');
    });

    it('should handle various file extensions', () => {
      const tests = [
        { file: 'test.ts', lang: 'typescript' },
        { file: 'test.js', lang: 'javascript' },
        { file: 'test.py', lang: 'python' },
        { file: 'test.md', lang: 'markdown' },
        { file: 'test.json', lang: 'json' },
      ];

      tests.forEach(({ file, lang }) => {
        useArtifactStore.getState().setFileName(file);
        expect(useArtifactStore.getState().language).toBe(lang);
      });
    });
  });

  describe('closeArtifact', () => {
    it('should close artifact but preserve content', () => {
      useArtifactStore
        .getState()
        .openArtifact('test code', 'javascript', 'test.js');
      useArtifactStore.getState().closeArtifact();

      const state = useArtifactStore.getState();
      expect(state.isArtifactOpen).toBe(false);
      expect(state.isEditorOpen).toBe(false);
      // Content should still be there (no localStorage, but in memory)
      expect(state.modifiedCode).toBe('test code');
    });
  });

  describe('getArtifactContext', () => {
    it('should return null when editor is not open', async () => {
      expect(await useArtifactStore.getState().getArtifactContext()).toBeNull();
    });

    it('should return null when editor is open but has no content', async () => {
      useArtifactStore.getState().openArtifact('', 'javascript');

      expect(await useArtifactStore.getState().getArtifactContext()).toBeNull();
    });

    it('should return artifact context when editor has content', async () => {
      useArtifactStore
        .getState()
        .openArtifact('test code', 'javascript', 'test.js');

      const context = await useArtifactStore.getState().getArtifactContext();
      expect(context).toEqual({
        fileName: 'test.js',
        language: 'javascript',
        code: 'test code',
      });
    });
  });

  describe('downloadFile', () => {
    it('should create download link with correct attributes', () => {
      const mockLink = { href: '', download: '', click: vi.fn() };
      const createElementSpy = vi.fn().mockReturnValue(mockLink);
      const appendChildSpy = vi.fn();
      const removeChildSpy = vi.fn();
      const createObjectURLSpy = vi.fn().mockReturnValue('blob:test');
      const revokeObjectURLSpy = vi.fn();

      // Set up DOM globals for node environment
      globalThis.document = {
        createElement: createElementSpy,
        body: {
          appendChild: appendChildSpy,
          removeChild: removeChildSpy,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const originalCreateObjectURL = URL.createObjectURL;
      const originalRevokeObjectURL = URL.revokeObjectURL;
      URL.createObjectURL = createObjectURLSpy;
      URL.revokeObjectURL = revokeObjectURLSpy;

      try {
        useArtifactStore
          .getState()
          .openArtifact('test content', 'javascript', 'test.js');
        useArtifactStore.getState().downloadFile();

        expect(createElementSpy).toHaveBeenCalledWith('a');
        expect(createObjectURLSpy).toHaveBeenCalled();
        expect(revokeObjectURLSpy).toHaveBeenCalled();
      } finally {
        // Restore globals
        delete (globalThis as unknown as Record<string, unknown>).document;
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
      }
    });
  });

  describe('setLanguage', () => {
    it('should update language and filename when using default name', () => {
      useArtifactStore.getState().setLanguage('python');

      const state = useArtifactStore.getState();
      expect(state.language).toBe('python');
      expect(state.fileName).toBe('untitled.py');
    });

    it('should update language but not filename when using custom name', () => {
      useArtifactStore.getState().setFileName('myfile.js');
      useArtifactStore.getState().setLanguage('python');

      const state = useArtifactStore.getState();
      expect(state.language).toBe('python');
      expect(state.fileName).toBe('myfile.js'); // Should not change
    });
  });

  describe('resetEditor', () => {
    it('should reset all editor state to defaults', () => {
      useArtifactStore.getState().openArtifact('test', 'python', 'test.py');
      useArtifactStore.getState().setIsLoading(true);
      useArtifactStore.getState().setError('test error');

      useArtifactStore.getState().resetEditor();

      const state = useArtifactStore.getState();
      expect(state.originalCode).toBe('');
      expect(state.modifiedCode).toBe('');
      expect(state.language).toBe('typescript');
      expect(state.fileName).toBe('untitled.ts');
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });
  });
});
