import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import toast from 'react-hot-toast';

import { useTheme } from '@/client/hooks/ui/useTheme';

import CodeArtifact from '@/components/CodeEditor/CodeArtifact';

import { useArtifactStore } from '@/client/stores/artifactStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
vi.mock('@/client/stores/artifactStore');
vi.mock('@/client/hooks/ui/useTheme');
vi.mock('react-hot-toast');
vi.mock('@/components/CodeEditor/CodeEditor', () => ({
  default: ({ theme }: { theme: string }) => (
    <div data-testid="code-editor">Code Editor - {theme}</div>
  ),
}));

describe('CodeArtifact', () => {
  const mockOnClose = vi.fn();
  const mockOnSwitchToDocument = vi.fn();
  const mockDownloadFile = vi.fn();
  const mockSetFileName = vi.fn();
  const mockSetIsEditorOpen = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock useTheme
    (useTheme as any).mockReturnValue('dark');

    // Mock useArtifactStore
    (useArtifactStore as any).mockReturnValue({
      fileName: 'test.js',
      language: 'javascript',
      modifiedCode: 'console.log("test");',
      downloadFile: mockDownloadFile,
      setFileName: mockSetFileName,
      setIsEditorOpen: mockSetIsEditorOpen,
    });

    // Mock toast
    (toast.success as any).mockImplementation(() => {});
    (toast.error as any).mockImplementation(() => {});
  });

  describe('Rendering', () => {
    it('should render the code artifact with toolbar', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      expect(screen.getByText('test.js')).toBeInTheDocument();
      expect(screen.getByText('javascript')).toBeInTheDocument();
      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    it('should show disclaimer footer', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      expect(
        screen.getByText(
          'Edits are not saved. Send via message or download to save any edits.',
        ),
      ).toBeInTheDocument();
    });

    it('should not show experimental badge', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      expect(screen.queryByText('Experimental')).not.toBeInTheDocument();
    });

    it('should render code editor with correct theme', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      expect(screen.getByText('Code Editor - dark')).toBeInTheDocument();
    });
  });

  describe('Filename Editing', () => {
    it('should allow editing filename on click', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      const filenameButton = screen.getByText('test.js');
      fireEvent.click(filenameButton);

      const input = screen.getByDisplayValue('test.js');
      expect(input).toBeInTheDocument();
      expect(input).toHaveFocus();
    });

    it('should update filename on change', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      const filenameButton = screen.getByText('test.js');
      fireEvent.click(filenameButton);

      const input = screen.getByDisplayValue('test.js');
      fireEvent.change(input, { target: { value: 'newfile.ts' } });

      expect(mockSetFileName).toHaveBeenCalledWith('newfile.ts');
    });

    it('should exit edit mode on blur', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      const filenameButton = screen.getByText('test.js');
      fireEvent.click(filenameButton);

      const input = screen.getByDisplayValue('test.js');
      fireEvent.blur(input);

      expect(screen.getByText('test.js')).toBeInTheDocument();
    });

    it('should exit edit mode on Enter key', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      const filenameButton = screen.getByText('test.js');
      fireEvent.click(filenameButton);

      const input = screen.getByDisplayValue('test.js');
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(screen.getByText('test.js')).toBeInTheDocument();
    });
  });

  describe('Toolbar Actions', () => {
    it('should show switch to document button when provided', () => {
      render(
        <CodeArtifact
          onClose={mockOnClose}
          onSwitchToDocument={mockOnSwitchToDocument}
        />,
      );

      const switchButton = screen.getByTitle('Switch to Document Editor');
      expect(switchButton).toBeInTheDocument();
    });

    it('should not show switch to document button when not provided', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      expect(
        screen.queryByTitle('Switch to Document Editor'),
      ).not.toBeInTheDocument();
    });

    it('should call onSwitchToDocument when button is clicked', () => {
      render(
        <CodeArtifact
          onClose={mockOnClose}
          onSwitchToDocument={mockOnSwitchToDocument}
        />,
      );

      const switchButton = screen.getByTitle('Switch to Document Editor');
      fireEvent.click(switchButton);

      expect(mockOnSwitchToDocument).toHaveBeenCalledTimes(1);
    });

    it('should download file when download button is clicked', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      const downloadButton = screen.getByTitle('Download');
      fireEvent.click(downloadButton);

      expect(mockDownloadFile).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith('File downloaded');
    });

    it('should disable download button when no code', () => {
      (useArtifactStore as any).mockReturnValue({
        fileName: 'test.js',
        language: 'javascript',
        modifiedCode: '',
        downloadFile: mockDownloadFile,
        setFileName: mockSetFileName,
        setIsEditorOpen: mockSetIsEditorOpen,
      });

      render(<CodeArtifact onClose={mockOnClose} />);

      const downloadButton = screen.getByTitle('Download');
      expect(downloadButton).toBeDisabled();
    });

    it('should show error toast when download fails', () => {
      mockDownloadFile.mockImplementation(() => {
        throw new Error('Download failed');
      });

      render(<CodeArtifact onClose={mockOnClose} />);

      const downloadButton = screen.getByTitle('Download');
      fireEvent.click(downloadButton);

      expect(toast.error).toHaveBeenCalledWith('Failed to download');
    });

    it('should call onClose when close button is clicked', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      const closeButton = screen.getByTitle('Close');
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Editor State Management', () => {
    it('should set isEditorOpen to true on mount', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      expect(mockSetIsEditorOpen).toHaveBeenCalledWith(true);
    });

    it('should set isEditorOpen to false on unmount', () => {
      const { unmount } = render(<CodeArtifact onClose={mockOnClose} />);

      unmount();

      expect(mockSetIsEditorOpen).toHaveBeenCalledWith(false);
    });
  });

  describe('Styling and Layout', () => {
    it('should have correct flex layout structure', () => {
      const { container } = render(<CodeArtifact onClose={mockOnClose} />);

      const mainContainer = container.firstChild;
      expect(mainContainer).toHaveClass('flex', 'flex-col', 'h-full', 'w-full');
    });

    it('should have toolbar with correct styling', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      const toolbar = screen.getByText('test.js').closest('div')?.parentElement;
      expect(toolbar).toHaveClass(
        'flex',
        'items-center',
        'justify-between',
        'border-b',
      );
    });

    it('should have footer with correct styling', () => {
      const { container } = render(<CodeArtifact onClose={mockOnClose} />);

      const footer = container.querySelector('.border-t');
      expect(footer).toBeInTheDocument();
      expect(footer).toHaveClass('px-4', 'py-2');
    });

    it('should constrain left section width to prevent pushing buttons off-screen', () => {
      render(<CodeArtifact onClose={mockOnClose} />);

      // The left section (filename area) should have max-width constraint
      const filenameButton = screen.getByText('test.js');
      const leftSection = filenameButton.closest('div');
      expect(leftSection).toHaveClass('max-w-[calc(100%-160px)]');
    });

    it('should keep action buttons accessible with very long filename', () => {
      const longFilename = 'a'.repeat(100) + '.js';
      (useArtifactStore as any).mockReturnValue({
        fileName: longFilename,
        language: 'javascript',
        modifiedCode: 'console.log("test");',
        downloadFile: mockDownloadFile,
        setFileName: mockSetFileName,
        setIsEditorOpen: mockSetIsEditorOpen,
      });

      render(
        <CodeArtifact
          onClose={mockOnClose}
          onSwitchToDocument={mockOnSwitchToDocument}
        />,
      );

      // All action buttons should still be in the document and accessible
      expect(
        screen.getByTitle('Switch to Document Editor'),
      ).toBeInTheDocument();
      expect(screen.getByTitle('Download')).toBeInTheDocument();
      expect(screen.getByTitle('Close')).toBeInTheDocument();

      // Filename should have truncate class for text overflow
      const filenameButton = screen.getByText(longFilename);
      expect(filenameButton).toHaveClass('truncate');
    });
  });
});
