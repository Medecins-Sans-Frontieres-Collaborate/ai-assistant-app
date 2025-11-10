import { render } from '@testing-library/react';
import React from 'react';

import FileIcon from '@/components/Icons/file';
import ImageIcon from '@/components/Icons/image';
import MicIcon from '@/components/Icons/mic';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

describe('Icon Components', () => {
  describe('FileIcon', () => {
    it('renders as svg element', () => {
      const { container } = render(<FileIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('has default width and height of 24', () => {
      const { container } = render(<FileIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('width', '24');
      expect(svg).toHaveAttribute('height', '24');
    });

    it('has correct viewBox', () => {
      const { container } = render(<FileIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    });

    it('accepts custom className', () => {
      const { container } = render(<FileIcon className="custom-class" />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveClass('custom-class');
    });

    it('accepts custom width and height props', () => {
      const { container } = render(<FileIcon width="32" height="32" />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('width', '32');
      expect(svg).toHaveAttribute('height', '32');
    });

    it('accepts custom stroke color', () => {
      const { container } = render(<FileIcon stroke="red" />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('stroke', 'red');
    });

    it('has correct path elements', () => {
      const { container } = render(<FileIcon />);
      const paths = container.querySelectorAll('path, polyline');
      expect(paths.length).toBeGreaterThan(0);
    });
  });

  describe('MicIcon', () => {
    it('renders as svg element', () => {
      const { container } = render(<MicIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('has default width and height of 24', () => {
      const { container } = render(<MicIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('width', '24');
      expect(svg).toHaveAttribute('height', '24');
    });

    it('has correct viewBox', () => {
      const { container } = render(<MicIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    });

    it('accepts custom className', () => {
      const { container } = render(<MicIcon className="mic-icon" />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveClass('mic-icon');
    });

    it('accepts custom width and height props', () => {
      const { container } = render(<MicIcon width="48" height="48" />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('width', '48');
      expect(svg).toHaveAttribute('height', '48');
    });

    it('has microphone path elements', () => {
      const { container } = render(<MicIcon />);
      const paths = container.querySelectorAll('path, line');
      expect(paths.length).toBeGreaterThan(0);
    });

    it('accepts strokeWidth prop', () => {
      const { container } = render(<MicIcon strokeWidth="3" />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('stroke-width', '3');
    });
  });

  describe('ImageIcon', () => {
    it('renders as svg element', () => {
      const { container } = render(<ImageIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('has default width and height of 18', () => {
      const { container } = render(<ImageIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('width', '18');
      expect(svg).toHaveAttribute('height', '18');
    });

    it('has correct viewBox', () => {
      const { container } = render(<ImageIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    });

    it('accepts custom className', () => {
      const { container } = render(<ImageIcon className="image-icon" />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveClass('image-icon');
    });

    it('accepts custom width and height props', () => {
      const { container } = render(<ImageIcon width="36" height="36" />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('width', '36');
      expect(svg).toHaveAttribute('height', '36');
    });

    it('has image shape elements', () => {
      const { container } = render(<ImageIcon />);
      const rect = container.querySelector('rect');
      const circle = container.querySelector('circle');
      const path = container.querySelector('path');

      expect(rect).toBeInTheDocument();
      expect(circle).toBeInTheDocument();
      expect(path).toBeInTheDocument();
    });

    it('accepts custom fill prop', () => {
      const { container } = render(<ImageIcon fill="blue" />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('fill', 'blue');
    });
  });

  describe('Icon Props Spreading', () => {
    it('FileIcon spreads all SVG props', () => {
      const { container } = render(
        <FileIcon data-testid="file-icon" aria-label="File icon" role="img" />,
      );
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('data-testid', 'file-icon');
      expect(svg).toHaveAttribute('aria-label', 'File icon');
      expect(svg).toHaveAttribute('role', 'img');
    });

    it('MicIcon spreads all SVG props', () => {
      const { container } = render(
        <MicIcon data-testid="mic-icon" aria-label="Microphone icon" />,
      );
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('data-testid', 'mic-icon');
      expect(svg).toHaveAttribute('aria-label', 'Microphone icon');
    });

    it('ImageIcon spreads all SVG props', () => {
      const { container } = render(
        <ImageIcon data-testid="image-icon" aria-label="Image icon" />,
      );
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('data-testid', 'image-icon');
      expect(svg).toHaveAttribute('aria-label', 'Image icon');
    });
  });
});
