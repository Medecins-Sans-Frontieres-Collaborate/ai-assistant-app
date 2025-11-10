import React from 'react';

import { fetchImageBase64FromMessageContent } from '@/lib/services/imageService';

import { ImageMessageContent } from '@/types/chat';

import { ImageContent } from '@/components/Chat/ChatMessages/ImageContent';

import { fireEvent, render, screen, waitFor } from '@/__tests__/testUtils';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the image service
vi.mock('@/lib/services/imageService', () => ({
  fetchImageBase64FromMessageContent: vi.fn(),
}));

describe('ImageContent', () => {
  const mockFetchImageBase64 = fetchImageBase64FromMessageContent as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createImageContent = (url: string): ImageMessageContent => ({
    type: 'image_url',
    image_url: {
      url,
      detail: 'auto',
    },
  });

  describe('Loading State', () => {
    it('displays loading state initially', () => {
      mockFetchImageBase64.mockImplementation(
        () => new Promise(() => {}), // Never resolves
      );

      const images = [createImageContent('https://example.com/image1.jpg')];
      render(<ImageContent images={images} />);

      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });

    it('displays loading skeleton for single image', () => {
      mockFetchImageBase64.mockImplementation(() => new Promise(() => {}));

      const images = [createImageContent('https://example.com/image1.jpg')];
      const { container } = render(<ImageContent images={images} />);

      const skeleton = container.querySelector('.animate-pulse');
      expect(skeleton).toBeInTheDocument();
      expect(skeleton).toHaveClass('w-full', 'max-w-md');
    });

    it('displays loading skeletons for multiple images', () => {
      mockFetchImageBase64.mockImplementation(() => new Promise(() => {}));

      const images = [
        createImageContent('https://example.com/image1.jpg'),
        createImageContent('https://example.com/image2.jpg'),
      ];
      const { container } = render(<ImageContent images={images} />);

      const skeletons = container.querySelectorAll('.animate-pulse');
      expect(skeletons).toHaveLength(2);
      skeletons.forEach((skeleton) => {
        expect(skeleton).toHaveClass('w-[calc(50%-0.25rem)]');
      });
    });
  });

  describe('Successful Image Loading', () => {
    it('displays single image after loading', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageContent('https://example.com/image1.jpg')];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image 1');
        expect(img).toBeInTheDocument();
        expect(img).toHaveAttribute('src', 'data:image/png;base64,abc123');
      });
    });

    it('displays multiple images after loading', async () => {
      mockFetchImageBase64.mockImplementation((image: ImageMessageContent) => {
        if (image.image_url.url.includes('image1')) {
          return Promise.resolve('data:image/png;base64,image1');
        }
        return Promise.resolve('data:image/png;base64,image2');
      });

      const images = [
        createImageContent('https://example.com/image1.jpg'),
        createImageContent('https://example.com/image2.jpg'),
      ];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        expect(screen.getByAltText('Image 1')).toBeInTheDocument();
        expect(screen.getByAltText('Image 2')).toBeInTheDocument();
      });
    });

    it('applies correct styling for single image', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageContent('https://example.com/image1.jpg')];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image 1');
        expect(img).toHaveClass('w-full', 'max-w-md');
        expect(img).toHaveStyle({ maxHeight: '400px' });
      });
    });

    it('applies correct styling for multiple images', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [
        createImageContent('https://example.com/image1.jpg'),
        createImageContent('https://example.com/image2.jpg'),
      ];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        const img1 = screen.getByAltText('Image 1');
        const img2 = screen.getByAltText('Image 2');

        expect(img1).toHaveClass('w-[calc(50%-0.25rem)]');
        expect(img2).toHaveClass('w-[calc(50%-0.25rem)]');
        expect(img1).toHaveStyle({ height: '200px', maxHeight: '200px' });
        expect(img2).toHaveStyle({ height: '200px', maxHeight: '200px' });
      });
    });
  });

  describe('Error State', () => {
    it('displays error message when fetch fails', async () => {
      mockFetchImageBase64.mockRejectedValue(new Error('Fetch failed'));

      const images = [createImageContent('https://example.com/image1.jpg')];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load image(s)')).toBeInTheDocument();
      });
    });

    it('displays error when base64 string is empty', async () => {
      mockFetchImageBase64.mockResolvedValue('');

      const images = [createImageContent('https://example.com/image1.jpg')];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load image(s)')).toBeInTheDocument();
      });
    });

    it('displays error when some images fail to load', async () => {
      mockFetchImageBase64.mockImplementation((image: ImageMessageContent) => {
        if (image.image_url.url.includes('image1')) {
          return Promise.resolve('data:image/png;base64,image1');
        }
        return Promise.resolve(''); // Empty = failed
      });

      const images = [
        createImageContent('https://example.com/image1.jpg'),
        createImageContent('https://example.com/image2.jpg'),
      ];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load image(s)')).toBeInTheDocument();
      });
    });
  });

  describe('Lightbox Functionality', () => {
    it('opens lightbox when image is clicked', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageContent('https://example.com/image1.jpg')];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image 1');
        fireEvent.click(img);
      });

      await waitFor(() => {
        expect(screen.getByAltText('Full size preview')).toBeInTheDocument();
      });
    });

    it('closes lightbox when clicking close button', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageContent('https://example.com/image1.jpg')];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image 1');
        fireEvent.click(img);
      });

      await waitFor(() => {
        const closeButton = screen.getByLabelText('Close');
        fireEvent.click(closeButton);
      });

      await waitFor(() => {
        expect(
          screen.queryByAltText('Full size preview'),
        ).not.toBeInTheDocument();
      });
    });

    it('closes lightbox when clicking overlay', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageContent('https://example.com/image1.jpg')];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image 1');
        fireEvent.click(img);
      });

      await waitFor(() => {
        const overlay = screen.getByAltText('Full size preview').closest('div');
        if (overlay) {
          fireEvent.click(overlay);
        }
      });

      await waitFor(() => {
        expect(
          screen.queryByAltText('Full size preview'),
        ).not.toBeInTheDocument();
      });
    });
  });

  describe('Edge Cases', () => {
    it('handles empty images array', () => {
      const { container } = render(<ImageContent images={[]} />);

      // Should render nothing or minimal content
      expect(container.firstChild).toBeTruthy();
    });

    it('fetches all images in parallel', async () => {
      const images = [
        createImageContent('https://example.com/image1.jpg'),
        createImageContent('https://example.com/image2.jpg'),
        createImageContent('https://example.com/image3.jpg'),
      ];

      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      render(<ImageContent images={images} />);

      await waitFor(() => {
        expect(mockFetchImageBase64).toHaveBeenCalledTimes(3);
      });
    });

    it('re-fetches when images prop changes', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images1 = [createImageContent('https://example.com/image1.jpg')];
      const { rerender } = render(<ImageContent images={images1} />);

      await waitFor(() => {
        expect(mockFetchImageBase64).toHaveBeenCalledTimes(1);
      });

      const images2 = [createImageContent('https://example.com/image2.jpg')];
      rerender(<ImageContent images={images2} />);

      await waitFor(() => {
        expect(mockFetchImageBase64).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Accessibility', () => {
    it('has proper alt text for images', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [
        createImageContent('https://example.com/image1.jpg'),
        createImageContent('https://example.com/image2.jpg'),
      ];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        expect(screen.getByAltText('Image 1')).toBeInTheDocument();
        expect(screen.getByAltText('Image 2')).toBeInTheDocument();
      });
    });

    it('has clickable images with cursor pointer', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageContent('https://example.com/image1.jpg')];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image 1');
        expect(img).toHaveClass('hover:cursor-pointer');
      });
    });

    it('lightbox close button has aria-label', async () => {
      mockFetchImageBase64.mockResolvedValue('data:image/png;base64,abc123');

      const images = [createImageContent('https://example.com/image1.jpg')];
      render(<ImageContent images={images} />);

      await waitFor(() => {
        const img = screen.getByAltText('Image 1');
        fireEvent.click(img);
      });

      await waitFor(() => {
        expect(screen.getByLabelText('Close')).toBeInTheDocument();
      });
    });
  });
});
