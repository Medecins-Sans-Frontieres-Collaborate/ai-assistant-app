import { render, screen } from '@testing-library/react';
import React from 'react';

import { Citation } from '@/types/rag';

import { CitationListItem } from '@/components/Chat/Citations/CitationListItem';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe('CitationListItem', () => {
  const mockCitation: Citation = {
    title: 'Test Article Title',
    url: 'https://example.com/article',
    date: '2024-01-15',
    number: 1,
  };

  describe('Rendering', () => {
    it('renders citation title', () => {
      render(<CitationListItem citation={mockCitation} />);

      expect(screen.getByText('Test Article Title')).toBeInTheDocument();
    });

    it('renders citation number in brackets', () => {
      render(<CitationListItem citation={mockCitation} />);

      expect(screen.getByText('[1]')).toBeInTheDocument();
    });

    it('renders domain name from URL', () => {
      render(<CitationListItem citation={mockCitation} />);

      expect(screen.getByText('example')).toBeInTheDocument();
    });

    it('renders formatted date', () => {
      render(<CitationListItem citation={mockCitation} />);

      // Date parsing can vary by timezone, so we check that a formatted date is present
      const dateElement = screen.getByText(/Jan \d+, 2024/);
      expect(dateElement).toBeInTheDocument();
    });

    it('renders favicon using Google Favicon API', () => {
      const { container } = render(
        <CitationListItem citation={mockCitation} />,
      );

      const favicon = container.querySelector('img');
      expect(favicon).toHaveAttribute(
        'src',
        'https://www.google.com/s2/favicons?domain=example.com&size=16',
      );
    });

    it('renders as a link to the citation URL', () => {
      render(<CitationListItem citation={mockCitation} />);

      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', 'https://example.com/article');
    });

    it('opens link in new tab', () => {
      render(<CitationListItem citation={mockCitation} />);

      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  describe('Edge Cases', () => {
    it('returns null when title is missing', () => {
      const citationWithoutTitle: Citation = {
        ...mockCitation,
        title: '',
      };

      const { container } = render(
        <CitationListItem citation={citationWithoutTitle} />,
      );

      expect(container.firstChild).toBeNull();
    });

    it('returns null when URL is missing', () => {
      const citationWithoutUrl: Citation = {
        ...mockCitation,
        url: '',
      };

      const { container } = render(
        <CitationListItem citation={citationWithoutUrl} />,
      );

      expect(container.firstChild).toBeNull();
    });

    it('handles citation without date', () => {
      const citationWithoutDate: Citation = {
        ...mockCitation,
        date: '',
      };

      render(<CitationListItem citation={citationWithoutDate} />);

      expect(screen.getByText('Test Article Title')).toBeInTheDocument();
      // Date separator should not be present
      expect(screen.queryByText('|')).not.toBeInTheDocument();
    });

    it('handles whitespace-only date', () => {
      const citationWithWhitespaceDate: Citation = {
        ...mockCitation,
        date: '   ',
      };

      render(<CitationListItem citation={citationWithWhitespaceDate} />);

      expect(screen.getByText('Test Article Title')).toBeInTheDocument();
      expect(screen.queryByText('|')).not.toBeInTheDocument();
    });

    it('handles invalid URL gracefully', () => {
      const citationWithInvalidUrl: Citation = {
        ...mockCitation,
        url: 'not-a-valid-url',
      };

      const { container } = render(
        <CitationListItem citation={citationWithInvalidUrl} />,
      );

      expect(screen.getByText('Invalid URL')).toBeInTheDocument();
    });

    it('strips www from domain', () => {
      const citationWithWww: Citation = {
        ...mockCitation,
        url: 'https://www.example.com/article',
      };

      render(<CitationListItem citation={citationWithWww} />);

      expect(screen.getByText('example')).toBeInTheDocument();
    });

    it('handles long titles with truncation class', () => {
      const citationWithLongTitle: Citation = {
        ...mockCitation,
        title:
          'This is a very long article title that should be truncated when displayed in the list view',
      };

      const { container } = render(
        <CitationListItem citation={citationWithLongTitle} />,
      );

      const titleElement = container.querySelector('.truncate');
      expect(titleElement).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('has correct container styling', () => {
      render(<CitationListItem citation={mockCitation} />);

      const link = screen.getByRole('link');
      expect(link).toHaveClass('flex');
      expect(link).toHaveClass('items-center');
      expect(link).toHaveClass('rounded-lg');
    });

    it('has dark mode styling', () => {
      render(<CitationListItem citation={mockCitation} />);

      const link = screen.getByRole('link');
      expect(link).toHaveClass('dark:bg-surface-dark-base');
      expect(link).toHaveClass('dark:hover:bg-surface-dark');
    });

    it('has hover styling', () => {
      render(<CitationListItem citation={mockCitation} />);

      const link = screen.getByRole('link');
      expect(link).toHaveClass('hover:bg-gray-200');
      expect(link).toHaveClass('hover:border-blue-400/50');
    });

    it('citation number has correct styling', () => {
      const { container } = render(
        <CitationListItem citation={mockCitation} />,
      );

      const numberElement = container.querySelector('.text-blue-600');
      expect(numberElement).toBeInTheDocument();
      expect(numberElement).toHaveClass('font-semibold');
    });

    it('has transition styling', () => {
      render(<CitationListItem citation={mockCitation} />);

      const link = screen.getByRole('link');
      expect(link).toHaveClass('transition-all');
      expect(link).toHaveClass('duration-200');
    });
  });

  describe('Accessibility', () => {
    it('has title attribute for tooltip', () => {
      render(<CitationListItem citation={mockCitation} />);

      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('title', 'Test Article Title');
    });

    it('favicon has alt text', () => {
      const { container } = render(
        <CitationListItem citation={mockCitation} />,
      );

      const favicon = container.querySelector('img');
      expect(favicon).toHaveAttribute('alt', 'example.com favicon');
    });

    it('is keyboard accessible as a link', () => {
      render(<CitationListItem citation={mockCitation} />);

      const link = screen.getByRole('link');
      expect(link).toBeInTheDocument();
    });
  });

  describe('Different Citation Numbers', () => {
    it('displays single digit numbers correctly', () => {
      render(<CitationListItem citation={mockCitation} />);

      expect(screen.getByText('[1]')).toBeInTheDocument();
    });

    it('displays double digit numbers correctly', () => {
      const citationWithHighNumber: Citation = {
        ...mockCitation,
        number: 15,
      };

      render(<CitationListItem citation={citationWithHighNumber} />);

      expect(screen.getByText('[15]')).toBeInTheDocument();
    });
  });

  describe('Different Date Formats', () => {
    it('formats ISO date correctly', () => {
      render(<CitationListItem citation={mockCitation} />);

      // Date parsing can vary by timezone, so we check that a formatted date is present
      const dateElement = screen.getByText(/Jan \d+, 2024/);
      expect(dateElement).toBeInTheDocument();
    });

    it('handles different date string formats', () => {
      const citationWithDifferentDate: Citation = {
        ...mockCitation,
        date: '2023-12-25',
      };

      render(<CitationListItem citation={citationWithDifferentDate} />);

      // Date parsing can vary by timezone, so we check that a formatted date is present
      const dateElement = screen.getByText(/Dec \d+, 2023/);
      expect(dateElement).toBeInTheDocument();
    });
  });
});
