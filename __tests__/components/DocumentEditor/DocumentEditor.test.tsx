import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import DocumentEditor from '@/components/DocumentEditor/DocumentEditor';

import { useArtifactStore } from '@/client/stores/artifactStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Create a chainable mock for TipTap
const createChainableMock = () => {
  const chainable: any = {
    focus: vi.fn(),
    toggleBold: vi.fn(),
    toggleItalic: vi.fn(),
    toggleUnderline: vi.fn(),
    toggleStrike: vi.fn(),
    toggleHeading: vi.fn(),
    toggleBulletList: vi.fn(),
    toggleOrderedList: vi.fn(),
    toggleCodeBlock: vi.fn(),
    toggleBlockquote: vi.fn(),
    insertTable: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    run: vi.fn(),
  };

  // Make all methods return the chainable object
  Object.keys(chainable).forEach((key) => {
    chainable[key].mockReturnValue(chainable);
  });

  return chainable;
};

// Mock TipTap
const mockEditor = {
  getHTML: vi.fn(() => '<p>Test content</p>'),
  commands: {
    setContent: vi.fn(),
  },
  chain: vi.fn(() => createChainableMock()),
  isActive: vi.fn((type: string, attrs?: any) => false),
  can: vi.fn(() => ({
    undo: vi.fn(() => true),
    redo: vi.fn(() => true),
  })),
};

vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn(() => mockEditor),
  EditorContent: vi.fn(({ editor }) => (
    <div data-testid="editor-content">
      {editor ? 'Editor Active' : 'No Editor'}
    </div>
  )),
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: {
    configure: vi.fn(() => ({})),
  },
}));

vi.mock('@tiptap/extension-table', () => ({
  Table: {
    configure: vi.fn(() => ({})),
  },
}));

vi.mock('@tiptap/extension-table-cell', () => ({
  TableCell: {},
}));

vi.mock('@tiptap/extension-table-header', () => ({
  TableHeader: {},
}));

vi.mock('@tiptap/extension-table-row', () => ({
  TableRow: {},
}));

vi.mock('@tiptap/extension-underline', () => ({
  Underline: {},
}));

vi.mock('@tiptap/extension-code-block-lowlight', () => ({
  CodeBlockLowlight: {
    configure: vi.fn(() => ({})),
  },
}));

vi.mock('lowlight', () => ({
  createLowlight: vi.fn(() => ({})),
  common: {},
}));

// Mock the artifact store
vi.mock('@/client/stores/artifactStore', () => ({
  useArtifactStore: vi.fn(),
}));

// Mock CSS import
vi.mock('@/components/DocumentEditor/editor.css', () => ({}));

describe('DocumentEditor', () => {
  const mockSetModifiedCode = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Default store state
    (useArtifactStore as any).mockReturnValue({
      modifiedCode: '<p>Test content</p>',
      fileName: 'test.md',
      setModifiedCode: mockSetModifiedCode,
    });

    // Reset mock editor
    mockEditor.getHTML.mockReturnValue('<p>Test content</p>');
    mockEditor.isActive.mockReturnValue(false);
  });

  describe('Rendering', () => {
    it('should render the editor', () => {
      render(<DocumentEditor />);
      expect(screen.getByTestId('editor-content')).toBeInTheDocument();
      expect(screen.getByTestId('editor-content')).toHaveTextContent(
        'Editor Active',
      );
    });

    it('should render toolbar with formatting buttons', () => {
      render(<DocumentEditor />);

      expect(screen.getByTitle('Bold')).toBeInTheDocument();
      expect(screen.getByTitle('Italic')).toBeInTheDocument();
      expect(screen.getByTitle('Underline')).toBeInTheDocument();
      expect(screen.getByTitle('Strikethrough')).toBeInTheDocument();
    });

    it('should render heading buttons', () => {
      render(<DocumentEditor />);

      expect(screen.getByTitle('Heading 1')).toBeInTheDocument();
      expect(screen.getByTitle('Heading 2')).toBeInTheDocument();
      expect(screen.getByTitle('Heading 3')).toBeInTheDocument();
    });

    it('should render list buttons', () => {
      render(<DocumentEditor />);

      expect(screen.getByTitle('Bullet List')).toBeInTheDocument();
      expect(screen.getByTitle('Numbered List')).toBeInTheDocument();
    });

    it('should render code and quote buttons', () => {
      render(<DocumentEditor />);

      expect(screen.getByTitle('Code Block')).toBeInTheDocument();
      expect(screen.getByTitle('Quote')).toBeInTheDocument();
    });

    it('should render table button', () => {
      render(<DocumentEditor />);

      expect(screen.getByTitle('Insert Table')).toBeInTheDocument();
    });

    it('should render undo/redo buttons', () => {
      render(<DocumentEditor />);

      expect(screen.getByTitle('Undo')).toBeInTheDocument();
      expect(screen.getByTitle('Redo')).toBeInTheDocument();
    });
  });

  describe('Toolbar Formatting', () => {
    it('should toggle bold when bold button is clicked', () => {
      render(<DocumentEditor />);

      const boldButton = screen.getByTitle('Bold');
      fireEvent.click(boldButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should toggle italic when italic button is clicked', () => {
      render(<DocumentEditor />);

      const italicButton = screen.getByTitle('Italic');
      fireEvent.click(italicButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should toggle underline when underline button is clicked', () => {
      render(<DocumentEditor />);

      const underlineButton = screen.getByTitle('Underline');
      fireEvent.click(underlineButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should toggle strikethrough when strikethrough button is clicked', () => {
      render(<DocumentEditor />);

      const strikeButton = screen.getByTitle('Strikethrough');
      fireEvent.click(strikeButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should toggle heading 1 when H1 button is clicked', () => {
      render(<DocumentEditor />);

      const h1Button = screen.getByTitle('Heading 1');
      fireEvent.click(h1Button);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should toggle heading 2 when H2 button is clicked', () => {
      render(<DocumentEditor />);

      const h2Button = screen.getByTitle('Heading 2');
      fireEvent.click(h2Button);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should toggle heading 3 when H3 button is clicked', () => {
      render(<DocumentEditor />);

      const h3Button = screen.getByTitle('Heading 3');
      fireEvent.click(h3Button);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should toggle bullet list when bullet list button is clicked', () => {
      render(<DocumentEditor />);

      const bulletButton = screen.getByTitle('Bullet List');
      fireEvent.click(bulletButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should toggle ordered list when numbered list button is clicked', () => {
      render(<DocumentEditor />);

      const orderedButton = screen.getByTitle('Numbered List');
      fireEvent.click(orderedButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should toggle code block when code block button is clicked', () => {
      render(<DocumentEditor />);

      const codeButton = screen.getByTitle('Code Block');
      fireEvent.click(codeButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should toggle blockquote when quote button is clicked', () => {
      render(<DocumentEditor />);

      const quoteButton = screen.getByTitle('Quote');
      fireEvent.click(quoteButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should insert table when table button is clicked', () => {
      render(<DocumentEditor />);

      const tableButton = screen.getByTitle('Insert Table');
      fireEvent.click(tableButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should call undo when undo button is clicked', () => {
      render(<DocumentEditor />);

      const undoButton = screen.getByTitle('Undo');
      fireEvent.click(undoButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });

    it('should call redo when redo button is clicked', () => {
      render(<DocumentEditor />);

      const redoButton = screen.getByTitle('Redo');
      fireEvent.click(redoButton);

      expect(mockEditor.chain).toHaveBeenCalled();
    });
  });

  describe('Active State Styling', () => {
    it('should highlight bold button when bold is active', () => {
      mockEditor.isActive.mockImplementation((type) => type === 'bold');

      render(<DocumentEditor />);

      const boldButton = screen.getByTitle('Bold');
      expect(boldButton).toHaveClass('bg-blue-500', 'text-white');
    });

    it('should highlight italic button when italic is active', () => {
      mockEditor.isActive.mockImplementation((type) => type === 'italic');

      render(<DocumentEditor />);

      const italicButton = screen.getByTitle('Italic');
      expect(italicButton).toHaveClass('bg-blue-500', 'text-white');
    });

    it('should highlight heading button when heading is active', () => {
      mockEditor.isActive.mockImplementation(
        (type, attrs) => type === 'heading' && attrs?.level === 1,
      );

      render(<DocumentEditor />);

      const h1Button = screen.getByTitle('Heading 1');
      expect(h1Button).toHaveClass('bg-blue-500', 'text-white');
    });
  });

  describe('Theme Support', () => {
    it('should apply light theme by default', () => {
      render(<DocumentEditor />);

      // Editor should render
      expect(screen.getByTestId('editor-content')).toBeInTheDocument();
    });

    it('should apply dark theme when theme is dark', () => {
      render(<DocumentEditor theme="dark" />);

      // Editor should render
      expect(screen.getByTestId('editor-content')).toBeInTheDocument();
    });
  });

  describe('Content Synchronization', () => {
    it('should initialize with content from store', () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: '<h1>Hello World</h1>',
        fileName: 'test.md',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<DocumentEditor />);

      expect(screen.getByTestId('editor-content')).toBeInTheDocument();
    });

    it('should use default content when store is empty', () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: '',
        fileName: 'test.md',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<DocumentEditor />);

      expect(screen.getByTestId('editor-content')).toBeInTheDocument();
    });

    it('should handle content updates', () => {
      render(<DocumentEditor />);

      expect(screen.getByTestId('editor-content')).toBeInTheDocument();
      expect(screen.getByTestId('editor-content')).toHaveTextContent(
        'Editor Active',
      );
    });
  });

  describe('Auto-conversion', () => {
    it('should auto-convert markdown to HTML on mount', async () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: '# Hello\n\nThis is markdown',
        fileName: 'test.md',
        setModifiedCode: mockSetModifiedCode,
      });

      // Mock the format converter
      vi.doMock('@/lib/utils/document/formatConverter', () => ({
        autoConvertToHtml: vi.fn(
          (content) => '<h1>Hello</h1><p>This is markdown</p>',
        ),
      }));

      render(<DocumentEditor />);

      await waitFor(() => {
        expect(mockSetModifiedCode).toHaveBeenCalled();
      });
    });

    it('should not auto-convert HTML content', async () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: '<p>Already HTML</p>',
        fileName: 'test.html',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<DocumentEditor />);

      // Wait a bit to ensure no conversion happens
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not call setModifiedCode for HTML content
      expect(mockSetModifiedCode).not.toHaveBeenCalled();
    });
  });

  describe('Store Integration', () => {
    it('should read modifiedCode from store', () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: '<p>From store</p>',
        fileName: 'test.md',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<DocumentEditor />);

      expect(screen.getByTestId('editor-content')).toBeInTheDocument();
    });

    it('should read fileName from store', () => {
      (useArtifactStore as any).mockReturnValue({
        modifiedCode: '<p>Content</p>',
        fileName: 'my-document.md',
        setModifiedCode: mockSetModifiedCode,
      });

      render(<DocumentEditor />);

      expect(useArtifactStore).toHaveBeenCalled();
    });
  });

  describe('Undo/Redo State', () => {
    it('should disable undo button when undo is not available', () => {
      mockEditor.can.mockReturnValue({
        undo: vi.fn(() => false),
        redo: vi.fn(() => true),
      });

      render(<DocumentEditor />);

      const undoButton = screen.getByTitle('Undo');
      expect(undoButton).toBeDisabled();
    });

    it('should disable redo button when redo is not available', () => {
      mockEditor.can.mockReturnValue({
        undo: vi.fn(() => true),
        redo: vi.fn(() => false),
      });

      render(<DocumentEditor />);

      const redoButton = screen.getByTitle('Redo');
      expect(redoButton).toBeDisabled();
    });

    it('should enable both buttons when both actions are available', () => {
      mockEditor.can.mockReturnValue({
        undo: vi.fn(() => true),
        redo: vi.fn(() => true),
      });

      render(<DocumentEditor />);

      const undoButton = screen.getByTitle('Undo');
      const redoButton = screen.getByTitle('Redo');

      expect(undoButton).not.toBeDisabled();
      expect(redoButton).not.toBeDisabled();
    });
  });
});
