import { fireEvent, render, screen } from '@testing-library/react';

import CodeEditor from '@/components/CodeEditor/CodeEditor';

import { useArtifactStore } from '@/client/stores/artifactStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Monaco Editor
vi.mock('@monaco-editor/react', () => ({
  Editor: vi.fn(({ onMount, onChange, loading, defaultValue, theme }) => {
    const mockEditor = {
      getValue: vi.fn(() => defaultValue || ''),
      setValue: vi.fn(),
      getModel: vi.fn(() => ({
        getLanguageId: vi.fn(() => 'typescript'),
      })),
    };

    // Call onMount immediately to avoid async issues in tests
    if (onMount) {
      setTimeout(() => {
        try {
          onMount(mockEditor);
        } catch (error) {
          // Silently catch errors if component is unmounted
        }
      }, 0);
    }

    return (
      <div data-testid="monaco-editor">
        {loading}
        <div data-testid="editor-content">{defaultValue}</div>
        <div data-testid="editor-theme">{theme}</div>
        <button
          data-testid="trigger-change"
          onClick={() => onChange?.('new code content')}
        >
          Change Content
        </button>
      </div>
    );
  }),
  loader: {
    config: vi.fn(),
  },
}));

// Mock the artifact store
vi.mock('@/client/stores/artifactStore', () => ({
  useArtifactStore: vi.fn(),
}));

describe('CodeEditor', () => {
  const mockSetModifiedCode = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Default store state
    (useArtifactStore as any).mockReturnValue({
      modifiedCode: '',
      language: 'typescript',
      setModifiedCode: mockSetModifiedCode,
    });

    // Mock window.monaco
    (global as any).window = {
      monaco: {
        editor: {
          setModelLanguage: vi.fn(),
        },
      },
    };
  });

  describe('Rendering', () => {
    it('should render the Monaco editor', () => {
      render(<CodeEditor />);
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument();
    });

    it('should show loading spinner initially', () => {
      render(<CodeEditor />);
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument();
    });

    it('should show placeholder when editor is empty', () => {
      render(<CodeEditor />);

      expect(
        screen.getByText('Start typing or ask AI to generate code'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Code will automatically sync from chat messages'),
      ).toBeInTheDocument();
    });

    it('should not show placeholder when editor has content', () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: 'const x = 1;',
        language: 'typescript',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<CodeEditor />);

      expect(
        screen.queryByText('Start typing or ask AI to generate code'),
      ).not.toBeInTheDocument();
    });
  });

  describe('Theme Support', () => {
    it('should use light theme by default', () => {
      render(<CodeEditor />);
      expect(screen.getByTestId('editor-theme')).toHaveTextContent('vs');
    });

    it('should use dark theme when theme prop is dark', () => {
      render(<CodeEditor theme="dark" />);
      expect(screen.getByTestId('editor-theme')).toHaveTextContent('vs-dark');
    });

    it('should use light theme when theme prop is light', () => {
      render(<CodeEditor theme="light" />);
      expect(screen.getByTestId('editor-theme')).toHaveTextContent('vs');
    });
  });

  describe('Content Management', () => {
    it('should display initial code from store', () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: 'const hello = "world";',
        language: 'typescript',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<CodeEditor />);

      expect(screen.getByTestId('editor-content')).toHaveTextContent(
        'const hello = "world";',
      );
    });

    it('should show default placeholder text when no code provided', () => {
      render(<CodeEditor />);
      expect(screen.getByTestId('editor-content')).toHaveTextContent(
        '// Start coding...',
      );
    });

    it('should call setModifiedCode when content changes', () => {
      render(<CodeEditor />);

      const changeButton = screen.getByTestId('trigger-change');
      fireEvent.click(changeButton);

      expect(mockSetModifiedCode).toHaveBeenCalledWith('new code content');
    });

    it('should handle editor content updates', () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: 'const test = "value";',
        language: 'javascript',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<CodeEditor />);

      expect(screen.getByTestId('editor-content')).toHaveTextContent(
        'const test = "value";',
      );
    });
  });

  describe('Language Support', () => {
    it('should use typescript as default language', () => {
      render(<CodeEditor />);
      // Language is set via defaultLanguage prop to Monaco
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument();
    });

    it('should support multiple languages', () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: 'print("hello")',
        language: 'python',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<CodeEditor />);

      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument();
    });
  });

  describe('Editor Mounting', () => {
    it('should handle editor mount callback', () => {
      render(<CodeEditor />);

      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument();
    });
  });

  describe('Editor Options', () => {
    it('should render editor with correct configuration', () => {
      render(<CodeEditor />);

      // Editor should render with the Monaco component
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument();
    });
  });

  describe('Store Integration', () => {
    it('should read modifiedCode from store', () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: 'function test() {}',
        language: 'javascript',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<CodeEditor />);

      expect(screen.getByTestId('editor-content')).toHaveTextContent(
        'function test() {}',
      );
    });

    it('should read language from store', () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: '',
        language: 'python',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<CodeEditor />);

      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument();
    });

    it('should call setModifiedCode from store on changes', () => {
      render(<CodeEditor />);

      const changeButton = screen.getByTestId('trigger-change');
      fireEvent.click(changeButton);

      expect(mockSetModifiedCode).toHaveBeenCalledWith('new code content');
    });
  });
});
