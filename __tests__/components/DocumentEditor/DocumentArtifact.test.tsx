import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import toast from 'react-hot-toast';

import { useTheme } from '@/client/hooks/ui/useTheme';

import DocumentArtifact from '@/components/DocumentEditor/DocumentArtifact';

import { useArtifactStore } from '@/client/stores/artifactStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
vi.mock('@/client/stores/artifactStore');
vi.mock('@/client/hooks/ui/useTheme');
vi.mock('react-hot-toast');
vi.mock('@/components/DocumentEditor/DocumentEditor', () => ({
  default: ({ theme }: { theme: string }) => (
    <div data-testid="document-editor">Document Editor - {theme}</div>
  ),
}));

// Mock export utilities
vi.mock('@/lib/utils/shared/document/exportUtils', () => ({
  htmlToMarkdown: vi.fn((html) => `# Markdown from ${html}`),
  htmlToPlainText: vi.fn((html) => `Plain text from ${html}`),
  exportToPDF: vi.fn().mockResolvedValue(undefined),
  exportToDOCX: vi.fn().mockResolvedValue(undefined),
  downloadFile: vi.fn(),
}));

describe('DocumentArtifact', () => {
  const mockOnClose = vi.fn();
  const mockOnSwitchToCode = vi.fn();
  const mockSetFileName = vi.fn();
  const mockSetIsEditorOpen = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock useTheme
    (useTheme as any).mockReturnValue('light');

    // Mock useArtifactStore
    (useArtifactStore as any).mockReturnValue({
      fileName: 'test.md',
      modifiedCode: '<p>Test content</p>',
      setFileName: mockSetFileName,
      setIsEditorOpen: mockSetIsEditorOpen,
    });

    // Mock toast
    (toast.success as any).mockImplementation(() => {});
    (toast.error as any).mockImplementation(() => {});
    (toast.loading as any).mockImplementation(() => {});
    (toast.dismiss as any).mockImplementation(() => {});
  });

  describe('Rendering', () => {
    it('should render the document artifact with toolbar', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      expect(screen.getByText('test.md')).toBeInTheDocument();
      expect(screen.getByText('Document')).toBeInTheDocument();
      expect(screen.getByTestId('document-editor')).toBeInTheDocument();
    });

    it('should show disclaimer footer', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      expect(
        screen.getByText(
          'Edits are not saved. Send via message or download to save any edits.',
        ),
      ).toBeInTheDocument();
    });

    it('should not show experimental badge', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      expect(screen.queryByText('Experimental')).not.toBeInTheDocument();
    });

    it('should render document editor with correct theme', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      expect(screen.getByText('Document Editor - light')).toBeInTheDocument();
    });
  });

  describe('Filename Editing', () => {
    it('should allow editing filename on click', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const filenameButton = screen.getByText('test.md');
      fireEvent.click(filenameButton);

      const input = screen.getByDisplayValue('test.md');
      expect(input).toBeInTheDocument();
      expect(input).toHaveFocus();
    });

    it('should update filename on change', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const filenameButton = screen.getByText('test.md');
      fireEvent.click(filenameButton);

      const input = screen.getByDisplayValue('test.md');
      fireEvent.change(input, { target: { value: 'newdoc.md' } });

      expect(mockSetFileName).toHaveBeenCalledWith('newdoc.md');
    });

    it('should exit edit mode on blur', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const filenameButton = screen.getByText('test.md');
      fireEvent.click(filenameButton);

      const input = screen.getByDisplayValue('test.md');
      fireEvent.blur(input);

      expect(screen.getByText('test.md')).toBeInTheDocument();
    });

    it('should exit edit mode on Enter key', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const filenameButton = screen.getByText('test.md');
      fireEvent.click(filenameButton);

      const input = screen.getByDisplayValue('test.md');
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(screen.getByText('test.md')).toBeInTheDocument();
    });
  });

  describe('Toolbar Actions', () => {
    it('should call onSwitchToCode when code button is clicked', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const switchButton = screen.getByTitle('Switch to Code Editor');
      fireEvent.click(switchButton);

      expect(mockOnSwitchToCode).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when close button is clicked', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const closeButton = screen.getByTitle('Close');
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Export Functionality', () => {
    it('should show export menu when export button is clicked', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const exportButton = screen.getByTitle('Export Document');
      fireEvent.click(exportButton);

      expect(screen.getByText('Markdown (.md)')).toBeInTheDocument();
      expect(screen.getByText('HTML (.html)')).toBeInTheDocument();
      expect(screen.getByText('Word (.docx)')).toBeInTheDocument();
      expect(screen.getByText('Plain Text (.txt)')).toBeInTheDocument();
      expect(screen.getByText('PDF (.pdf)')).toBeInTheDocument();
    });

    it('should disable export button when no content', () => {
      (useArtifactStore as any).mockReturnValue({
        fileName: 'test.md',
        modifiedCode: '',
        setFileName: mockSetFileName,
        setIsEditorOpen: mockSetIsEditorOpen,
      });

      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const exportButton = screen.getByTitle('Export Document');
      expect(exportButton).toBeDisabled();
    });

    it('should export as markdown', async () => {
      const { htmlToMarkdown, downloadFile } =
        await import('@/lib/utils/shared/document/exportUtils');

      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const exportButton = screen.getByTitle('Export Document');
      fireEvent.click(exportButton);

      const mdButton = screen.getByText('Markdown (.md)');
      fireEvent.click(mdButton);

      await waitFor(() => {
        expect(htmlToMarkdown).toHaveBeenCalledWith('<p>Test content</p>');
        expect(toast.success).toHaveBeenCalledWith('Exported as Markdown');
      });
    });

    it('should export as HTML', async () => {
      const { downloadFile } =
        await import('@/lib/utils/shared/document/exportUtils');

      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const exportButton = screen.getByTitle('Export Document');
      fireEvent.click(exportButton);

      const htmlButton = screen.getByText('HTML (.html)');
      fireEvent.click(htmlButton);

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Exported as HTML');
      });
    });

    it('should export as plain text', async () => {
      const { htmlToPlainText, downloadFile } =
        await import('@/lib/utils/shared/document/exportUtils');

      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const exportButton = screen.getByTitle('Export Document');
      fireEvent.click(exportButton);

      const txtButton = screen.getByText('Plain Text (.txt)');
      fireEvent.click(txtButton);

      await waitFor(() => {
        expect(htmlToPlainText).toHaveBeenCalledWith('<p>Test content</p>');
        expect(toast.success).toHaveBeenCalledWith('Exported as Text');
      });
    });

    it('should export as PDF', async () => {
      const { exportToPDF } =
        await import('@/lib/utils/shared/document/exportUtils');

      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const exportButton = screen.getByTitle('Export Document');
      fireEvent.click(exportButton);

      const pdfButton = screen.getByText('PDF (.pdf)');
      fireEvent.click(pdfButton);

      await waitFor(() => {
        expect(toast.loading).toHaveBeenCalledWith('Generating PDF...');
        expect(exportToPDF).toHaveBeenCalledWith(
          '<p>Test content</p>',
          'test.pdf',
        );
        expect(toast.dismiss).toHaveBeenCalled();
        expect(toast.success).toHaveBeenCalledWith('Exported as PDF');
      });
    });

    it('should export as DOCX', async () => {
      const { exportToDOCX } =
        await import('@/lib/utils/shared/document/exportUtils');

      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const exportButton = screen.getByTitle('Export Document');
      fireEvent.click(exportButton);

      const docxButton = screen.getByText('Word (.docx)');
      fireEvent.click(docxButton);

      await waitFor(() => {
        expect(toast.loading).toHaveBeenCalledWith('Generating DOCX...');
        expect(exportToDOCX).toHaveBeenCalledWith(
          '<p>Test content</p>',
          'test.docx',
        );
        expect(toast.dismiss).toHaveBeenCalled();
        expect(toast.success).toHaveBeenCalledWith('Exported as DOCX');
      });
    });

    it('should show error toast when export fails', async () => {
      const { exportToPDF } =
        await import('@/lib/utils/shared/document/exportUtils');
      (exportToPDF as any).mockRejectedValueOnce(new Error('Export failed'));

      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const exportButton = screen.getByTitle('Export Document');
      fireEvent.click(exportButton);

      const pdfButton = screen.getByText('PDF (.pdf)');
      fireEvent.click(pdfButton);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to export as PDF');
      });
    });

    it('should close export menu when clicking outside', async () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const exportButton = screen.getByTitle('Export Document');
      fireEvent.click(exportButton);

      expect(screen.getByText('Markdown (.md)')).toBeInTheDocument();

      // Simulate clicking outside
      fireEvent.click(document);

      await waitFor(() => {
        expect(screen.queryByText('Markdown (.md)')).not.toBeInTheDocument();
      });
    });
  });

  describe('Editor State Management', () => {
    it('should set isEditorOpen to true on mount', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      expect(mockSetIsEditorOpen).toHaveBeenCalledWith(true);
    });

    it('should set isEditorOpen to false on unmount', () => {
      const { unmount } = render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      unmount();

      expect(mockSetIsEditorOpen).toHaveBeenCalledWith(false);
    });
  });

  describe('Styling and Layout', () => {
    it('should have correct flex layout structure', () => {
      const { container } = render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const mainContainer = container.firstChild;
      expect(mainContainer).toHaveClass('flex', 'flex-col', 'h-full', 'w-full');
    });

    it('should have toolbar with correct styling', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const toolbar = screen.getByText('test.md').closest('div')?.parentElement;
      expect(toolbar).toHaveClass(
        'flex',
        'items-center',
        'justify-between',
        'border-b',
      );
    });

    it('should have footer with correct styling', () => {
      const { container } = render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      const footer = container.querySelector('.border-t');
      expect(footer).toBeInTheDocument();
      expect(footer).toHaveClass('px-4', 'py-2');
    });

    it('should constrain left section width to prevent pushing buttons off-screen', () => {
      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      // The left section (filename area) should have max-width constraint
      const filenameButton = screen.getByText('test.md');
      const leftSection = filenameButton.closest('div');
      expect(leftSection).toHaveClass('max-w-[calc(100%-180px)]');
    });

    it('should keep action buttons accessible with very long filename', () => {
      const longFilename = 'a'.repeat(100) + '.md';
      (useArtifactStore as any).mockReturnValue({
        fileName: longFilename,
        modifiedCode: '<p>Test content</p>',
        setFileName: mockSetFileName,
        setIsEditorOpen: mockSetIsEditorOpen,
      });

      render(
        <DocumentArtifact
          onClose={mockOnClose}
          onSwitchToCode={mockOnSwitchToCode}
        />,
      );

      // All action buttons should still be in the document and accessible
      expect(screen.getByTitle('Switch to Code Editor')).toBeInTheDocument();
      expect(screen.getByTitle('Export Document')).toBeInTheDocument();
      expect(screen.getByTitle('Close')).toBeInTheDocument();

      // Filename should have truncate class for text overflow
      const filenameButton = screen.getByText(longFilename);
      expect(filenameButton).toHaveClass('truncate');
    });
  });
});
