import { render, screen } from '@testing-library/react';
import React from 'react';

import { Citation } from '@/types/rag';

import { CitationItem } from '@/components/Chat/Citations/CitationItem';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

describe('CitationItem', () => {
  const mockCitation: Citation = {
    title: 'Example Article Title',
    url: 'https://www.example.com/article',
    date: '2024-01-15',
    number: 1,
  };

  describe('Rendering', () => {
    it('renders citation item with all data', () => {
      render(<CitationItem citation={mockCitation} />);

      expect(screen.getByText('Example Article Title')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
    });

    it('renders link with correct href', () => {
      render(<CitationItem citation={mockCitation} />);

      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', 'https://www.example.com/article');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('renders formatted date', () => {
      render(<CitationItem citation={mockCitation} />);

      // Date should be formatted (exact format may vary by timezone)
      // Just check that a date element exists with the correct classes
      const { container } = render(<CitationItem citation={mockCitation} />);
      const dateElement = container.querySelector('.text-\\[11px\\]');
      expect(dateElement).toBeInTheDocument();
      expect(dateElement?.textContent).toMatch(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
    });

    it('renders domain name from URL', () => {
      render(<CitationItem citation={mockCitation} />);

      expect(screen.getByText('example')).toBeInTheDocument();
    });

    it('renders favicon image', () => {
      render(<CitationItem citation={mockCitation} />);

      const favicon = screen.getByAltText('www.example.com favicon');
      expect(favicon).toBeInTheDocument();
      expect(favicon).toHaveAttribute(
        'src',
        'https://www.google.com/s2/favicons?domain=www.example.com&size=16',
      );
    });
  });

  describe('Conditional Rendering', () => {
    it('returns null when title is missing', () => {
      const citationWithoutTitle: Citation = {
        title: '',
        url: 'https://www.example.com',
        date: '2024-01-15',
        number: 1,
      };

      const { container } = render(
        <CitationItem citation={citationWithoutTitle} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('returns null when url is missing', () => {
      const citationWithoutUrl: Citation = {
        title: 'Example',
        url: '',
        date: '2024-01-15',
        number: 1,
      };

      const { container } = render(
        <CitationItem citation={citationWithoutUrl} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('does not render date section when date is missing', () => {
      const citationWithoutDate: Citation = {
        title: 'Example Article',
        url: 'https://www.example.com',
        date: '',
        number: 1,
      };

      const { container } = render(
        <CitationItem citation={citationWithoutDate} />,
      );

      // Should render the citation but not the date
      expect(screen.getByText('Example Article')).toBeInTheDocument();
      // Date element should not exist
      const dateElements = container.querySelectorAll('.text-\\[11px\\]');
      expect(dateElements.length).toBe(0);
    });

    it('does not render date section when date is empty string', () => {
      const citationWithEmptyDate: Citation = {
        title: 'Example Article',
        url: 'https://www.example.com',
        date: '',
        number: 1,
      };

      const { container } = render(
        <CitationItem citation={citationWithEmptyDate} />,
      );

      expect(screen.getByText('Example Article')).toBeInTheDocument();
      const dateElements = container.querySelectorAll('.text-\\[11px\\]');
      expect(dateElements.length).toBe(0);
    });

    it('does not render date section when date is whitespace', () => {
      const citationWithWhitespaceDate: Citation = {
        title: 'Example Article',
        url: 'https://www.example.com',
        date: '   ',
        number: 1,
      };

      const { container } = render(
        <CitationItem citation={citationWithWhitespaceDate} />,
      );

      expect(screen.getByText('Example Article')).toBeInTheDocument();
      const dateElements = container.querySelectorAll('.text-\\[11px\\]');
      expect(dateElements.length).toBe(0);
    });
  });

  describe('URL Processing', () => {
    it('handles www subdomain correctly', () => {
      const citation: Citation = {
        title: 'Test',
        url: 'https://www.github.com/test',
        date: '2024-01-01',
        number: 1,
      };

      render(<CitationItem citation={citation} />);
      expect(screen.getByText('github')).toBeInTheDocument();
    });

    it('handles URL without www', () => {
      const citation: Citation = {
        title: 'Test',
        url: 'https://stackoverflow.com/questions',
        date: '2024-01-01',
        number: 1,
      };

      render(<CitationItem citation={citation} />);
      expect(screen.getByText('stackoverflow')).toBeInTheDocument();
    });

    it('handles subdomain correctly', () => {
      const citation: Citation = {
        title: 'Test',
        url: 'https://docs.example.com/page',
        date: '2024-01-01',
        number: 1,
      };

      render(<CitationItem citation={citation} />);
      expect(screen.getByText('docs')).toBeInTheDocument();
    });

    it('handles invalid URL gracefully', () => {
      const citation: Citation = {
        title: 'Test',
        url: 'not-a-valid-url',
        date: '2024-01-01',
        number: 1,
      };

      render(<CitationItem citation={citation} />);
      expect(screen.getByText('Invalid URL')).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('has correct container classes', () => {
      const { container } = render(<CitationItem citation={mockCitation} />);

      const citationDiv = container.firstChild as HTMLElement;
      expect(citationDiv).toHaveClass('relative');
      expect(citationDiv).toHaveClass('bg-gray-200');
      expect(citationDiv).toHaveClass('dark:bg-[#171717]');
      expect(citationDiv).toHaveClass('rounded-lg');
    });

    it('has correct dimensions', () => {
      const { container } = render(<CitationItem citation={mockCitation} />);

      const citationDiv = container.firstChild as HTMLElement;
      expect(citationDiv).toHaveClass('h-[132px]');
      expect(citationDiv).toHaveClass('w-48');
    });

    it('title has line-clamp-3 class', () => {
      const { container } = render(<CitationItem citation={mockCitation} />);

      const titleDiv = container.querySelector('.line-clamp-3');
      expect(titleDiv).toBeInTheDocument();
      expect(titleDiv).toHaveTextContent('Example Article Title');
    });
  });

  describe('Accessibility', () => {
    it('link has title attribute', () => {
      render(<CitationItem citation={mockCitation} />);

      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('title', 'Example Article Title');
    });

    it('favicon has alt text', () => {
      render(<CitationItem citation={mockCitation} />);

      const favicon = screen.getByAltText('www.example.com favicon');
      expect(favicon).toBeInTheDocument();
    });
  });

  describe('Citation Number', () => {
    it('displays citation number', () => {
      render(<CitationItem citation={mockCitation} />);

      expect(screen.getByText('1')).toBeInTheDocument();
    });

    it('displays different citation numbers', () => {
      const citation2 = { ...mockCitation, number: 5 };
      render(<CitationItem citation={citation2} />);

      expect(screen.getByText('5')).toBeInTheDocument();
    });
  });
});
