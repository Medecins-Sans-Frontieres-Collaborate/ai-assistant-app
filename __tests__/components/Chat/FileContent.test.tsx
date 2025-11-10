import React from 'react';

import { fetchImageBase64FromMessageContent } from '@/lib/services/imageService';

import { FileMessageContent, ImageMessageContent } from '@/types/chat';

import { FileContent } from '@/components/Chat/ChatMessages/FileContent';

import { fireEvent, render, screen, waitFor } from '@/__tests__/testUtils';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the image service
vi.mock('@/lib/services/imageService', () => ({
  fetchImageBase64FromMessageContent: vi.fn(),
}));

// Mock tabler icons
vi.mock('@tabler/icons-react', () => ({
  IconDownload: ({ className }: any) =>
    React.createElement('div', { 'data-testid': 'download-icon', className }),
  IconX: ({ className }: any) =>
    React.createElement('div', { 'data-testid': 'close-icon', className }),
  IconFileText: ({ className }: any) =>
    React.createElement('div', { 'data-testid': 'file-text-icon', className }),
  IconCode: ({ className }: any) =>
    React.createElement('div', { 'data-testid': 'code-icon', className }),
}));

describe('FileContent', () => {
  const mockFetchImageBase64 = fetchImageBase64FromMessageContent as any;
  const mockWindowOpen = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.open = mockWindowOpen;
  });

  const createFileContent = (
    url: string,
    filename?: string,
  ): FileMessageContent => ({
    type: 'file_url',
    url,
    originalFilename: filename,
  });

  const createImageFileContent = (url: string): ImageMessageContent => ({
    type: 'image_url',
    image_url: {
      url,
      detail: 'auto',
    },
  });

  describe('File Rendering', () => {
    it('renders single file', () => {
      const files = [
        createFileContent('https://example.com/doc.pdf', 'document.pdf'),
      ];

      render(<FileContent files={files} images={[]} />);

      expect(screen.getByText('document.pdf')).toBeInTheDocument();
      expect(screen.getByTestId('download-icon')).toBeInTheDocument();
    });

    it('renders multiple files', () => {
      const files = [
        createFileContent('https://example.com/doc1.pdf', 'document1.pdf'),
        createFileContent('https://example.com/doc2.pdf', 'document2.pdf'),
      ];

      render(<FileContent files={files} images={[]} />);

      expect(screen.getByText('document1.pdf')).toBeInTheDocument();
      expect(screen.getByText('document2.pdf')).toBeInTheDocument();
    });

    it('displays filename from originalFilename property', () => {
      const files = [
        createFileContent('https://example.com/abc123.pdf', 'My Document.pdf'),
      ];

      render(<FileContent files={files} images={[]} />);

      expect(screen.getByText('My Document.pdf')).toBeInTheDocument();
    });

    it('extracts filename from URL when originalFilename is missing', () => {
      const files = [
        createFileContent('https://example.com/folder/report.pdf'),
      ];

      render(<FileContent files={files} images={[]} />);

      expect(screen.getByText('report.pdf')).toBeInTheDocument();
    });
  });

  describe('File Download Functionality', () => {
    it('opens download link when download button is clicked', () => {
      const files = [
        createFileContent('https://example.com/doc.pdf', 'document.pdf'),
      ];

      render(<FileContent files={files} images={[]} />);

      const downloadButton = screen.getByTitle('Download');
      fireEvent.click(downloadButton);

      expect(mockWindowOpen).toHaveBeenCalledWith(
        '/api/file/doc.pdf',
        '_blank',
      );
    });

    it('constructs correct download URL from file path', () => {
      const files = [
        createFileContent('https://example.com/folder/subfolder/file.xlsx'),
      ];

      render(<FileContent files={files} images={[]} />);

      const downloadButton = screen.getByTitle('Download');
      fireEvent.click(downloadButton);

      expect(mockWindowOpen).toHaveBeenCalledWith(
        '/api/file/file.xlsx',
        '_blank',
      );
    });
  });

  describe('Image File Rendering', () => {
    it('renders image file with image icon', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageFileContent('https://example.com/photo.jpg')];

      render(<FileContent files={[]} images={images} />);

      await waitFor(() => {
        expect(screen.getByTestId('download-icon')).toBeInTheDocument();
      });
    });

    it('displays loading state for image files', () => {
      mockFetchImageBase64.mockImplementation(() => new Promise(() => {}));

      const images = [createImageFileContent('https://example.com/photo.jpg')];

      render(<FileContent files={[]} images={images} />);

      expect(screen.getByText('Loading image...')).toBeInTheDocument();
    });

    it('displays loaded image thumbnail', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageFileContent('https://example.com/photo.jpg')];

      render(<FileContent files={[]} images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image Content');
        expect(img).toBeInTheDocument();
        expect(img).toHaveAttribute('src', 'data:image/png;base64,abc123');
      });
    });

    it('displays error message when image fails to load', async () => {
      mockFetchImageBase64.mockRejectedValue(new Error('Failed to load'));

      const images = [createImageFileContent('https://example.com/photo.jpg')];

      render(<FileContent files={[]} images={images} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load image')).toBeInTheDocument();
      });
    });

    it('displays error when image base64 is empty', async () => {
      mockFetchImageBase64.mockResolvedValue('');

      const images = [createImageFileContent('https://example.com/photo.jpg')];

      render(<FileContent files={[]} images={images} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load image')).toBeInTheDocument();
      });
    });
  });

  describe('Image Modal Functionality', () => {
    it('opens modal when image thumbnail is clicked', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageFileContent('https://example.com/photo.jpg')];

      render(<FileContent files={[]} images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image Content');
        fireEvent.click(img);
      });

      await waitFor(() => {
        expect(screen.getByAltText('Full size preview')).toBeInTheDocument();
      });
    });

    it('closes modal when clicking outside', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageFileContent('https://example.com/photo.jpg')];

      render(<FileContent files={[]} images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image Content');
        fireEvent.click(img);
      });

      await waitFor(() => {
        const modal = screen.getByAltText('Full size preview').closest('div');
        if (modal) {
          fireEvent.click(modal);
        }
      });

      await waitFor(() => {
        expect(
          screen.queryByAltText('Full size preview'),
        ).not.toBeInTheDocument();
      });
    });
  });

  describe('Mixed Content', () => {
    it('renders both files and images', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const files = [
        createFileContent('https://example.com/doc.pdf', 'document.pdf'),
      ];
      const images = [createImageFileContent('https://example.com/photo.jpg')];

      render(<FileContent files={files} images={images} />);

      expect(screen.getByText('document.pdf')).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByAltText('Image Content')).toBeInTheDocument();
      });
    });

    it('renders multiple files and multiple images', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const files = [
        createFileContent('https://example.com/doc1.pdf', 'document1.pdf'),
        createFileContent('https://example.com/doc2.pdf', 'document2.pdf'),
      ];
      const images = [
        createImageFileContent('https://example.com/photo1.jpg'),
        createImageFileContent('https://example.com/photo2.jpg'),
      ];

      render(<FileContent files={files} images={images} />);

      expect(screen.getByText('document1.pdf')).toBeInTheDocument();
      expect(screen.getByText('document2.pdf')).toBeInTheDocument();

      await waitFor(() => {
        const imageElements = screen.getAllByAltText('Image Content');
        expect(imageElements).toHaveLength(2);
      });
    });
  });

  describe('Edge Cases', () => {
    it('handles empty files and images arrays', () => {
      const { container } = render(<FileContent files={[]} images={[]} />);

      // Should render wrapper with no content
      expect(container.firstChild).toBeTruthy();
    });

    it('handles files with special characters in filename', () => {
      const files = [
        createFileContent(
          'https://example.com/file.pdf',
          'My File (2024) [Final].pdf',
        ),
      ];

      render(<FileContent files={files} images={[]} />);

      expect(
        screen.getByText('My File (2024) [Final].pdf'),
      ).toBeInTheDocument();
    });

    it('handles very long filenames', () => {
      const longFilename = 'a'.repeat(200) + '.pdf';
      const files = [
        createFileContent('https://example.com/file.pdf', longFilename),
      ];

      render(<FileContent files={files} images={[]} />);

      expect(screen.getByText(longFilename)).toBeInTheDocument();
    });
  });

  describe('Styling and Layout', () => {
    it('applies correct styling to file containers', () => {
      const files = [
        createFileContent('https://example.com/doc.pdf', 'document.pdf'),
      ];

      render(<FileContent files={files} images={[]} />);

      const fileContainer = screen
        .getByText('document.pdf')
        .closest('div[class*="hover:shadow-lg"]');
      expect(fileContainer).toBeInTheDocument();
      expect(fileContainer).toHaveClass('hover:shadow-lg');
    });

    it('displays download icon for files', () => {
      const files = [
        createFileContent('https://example.com/doc.pdf', 'document.pdf'),
      ];

      const { container } = render(<FileContent files={files} images={[]} />);

      // IconDownload is rendered (mocked as part of the file container)
      expect(screen.getByTestId('download-icon')).toBeInTheDocument();
    });

    it('applies correct layout classes', () => {
      const files = [
        createFileContent('https://example.com/doc.pdf', 'document.pdf'),
      ];

      const { container } = render(<FileContent files={files} images={[]} />);

      const wrapper = container.querySelector('.flex.flex-wrap');
      expect(wrapper).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('has proper image alt text', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageFileContent('https://example.com/photo.jpg')];

      render(<FileContent files={[]} images={images} />);

      await waitFor(() => {
        expect(screen.getByAltText('Image Content')).toBeInTheDocument();
      });
    });

    it('files have accessible action buttons', () => {
      const files = [
        createFileContent('https://example.com/doc.pdf', 'document.pdf'),
      ];

      render(<FileContent files={files} images={[]} />);

      // Check that the download button is accessible
      const downloadButton = screen.getByTitle('Download');
      expect(downloadButton).toBeInTheDocument();
      expect(downloadButton.tagName.toLowerCase()).toBe('button');
    });

    it('image thumbnails are clickable', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageFileContent('https://example.com/photo.jpg')];

      render(<FileContent files={[]} images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image Content');
        const imageContainer = img.closest('.cursor-pointer');
        expect(imageContainer).toHaveClass('cursor-pointer');
      });
    });
  });
});
