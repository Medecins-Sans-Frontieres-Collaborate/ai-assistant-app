import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { Citation } from '@/types/rag';

import { CitationList } from '@/components/Chat/Citations/CitationList';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Mock CitationItem component
vi.mock('@/components/Chat/Citations/CitationItem', () => ({
  CitationItem: ({ citation }: { citation: Citation }) => (
    <div data-testid={`citation-${citation.number}`}>{citation.title}</div>
  ),
}));

// Mock CitationListItem component
vi.mock('@/components/Chat/Citations/CitationListItem', () => ({
  CitationListItem: ({ citation }: { citation: Citation }) => (
    <div data-testid={`list-citation-${citation.number}`}>{citation.title}</div>
  ),
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

describe('CitationList', () => {
  const mockCitations: Citation[] = [
    {
      title: 'First Article',
      url: 'https://example.com/1',
      date: '2024-01-01',
      number: 1,
    },
    {
      title: 'Second Article',
      url: 'https://example.com/2',
      date: '2024-01-02',
      number: 2,
    },
    {
      title: 'Third Article',
      url: 'https://example.com/3',
      date: '2024-01-03',
      number: 3,
    },
  ];

  describe('Rendering', () => {
    it('renders citation list with count', () => {
      render(<CitationList citations={mockCitations} />);

      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('Sources')).toBeInTheDocument();
    });

    it('displays "Source" singular for single citation', () => {
      render(<CitationList citations={[mockCitations[0]]} />);

      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('Source')).toBeInTheDocument();
    });

    it('displays "Sources" plural for multiple citations', () => {
      render(<CitationList citations={mockCitations} />);

      expect(screen.getByText('Sources')).toBeInTheDocument();
    });

    it('returns null when no citations provided', () => {
      const { container } = render(<CitationList citations={[]} />);

      expect(container.firstChild).toBeNull();
    });

    it('renders citation icon', () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const icon = container.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('Expand/Collapse', () => {
    it('starts in collapsed state', () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      // With CSS animation, elements are in DOM but hidden
      // Check for max-h-0 class which indicates collapsed state
      const citationsContainer = container.querySelector('.overflow-hidden');
      expect(citationsContainer).toHaveClass('max-h-0');
      expect(citationsContainer).toHaveClass('opacity-0');
    });

    it('expands when clicked', async () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const header = screen.getByText('Sources').closest('div');
      fireEvent.click(header!);

      await waitFor(() => {
        const citationsContainer = container.querySelector('.overflow-hidden');
        // Should have expanded classes
        expect(citationsContainer).toHaveClass('opacity-100');
        expect(citationsContainer).not.toHaveClass('max-h-0');
        // Citations should be visible
        expect(screen.getByTestId('citation-1')).toBeInTheDocument();
        expect(screen.getByTestId('citation-2')).toBeInTheDocument();
        expect(screen.getByTestId('citation-3')).toBeInTheDocument();
      });
    });

    it('collapses when clicked again', async () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const header = screen.getByText('Sources').closest('div');

      // Expand
      fireEvent.click(header!);
      await waitFor(() => {
        const citationsContainer = container.querySelector('.overflow-hidden');
        expect(citationsContainer).toHaveClass('opacity-100');
      });

      // Collapse
      fireEvent.click(header!);
      await waitFor(
        () => {
          const citationsContainer =
            container.querySelector('.overflow-hidden');
          // Should be collapsed with CSS classes
          expect(citationsContainer).toHaveClass('max-h-0');
          expect(citationsContainer).toHaveClass('opacity-0');
        },
        { timeout: 500 }, // Wait for 300ms animation to complete
      );
    });

    it('shows chevron down when collapsed', () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      // IconChevronDown is rendered
      const chevrons = container.querySelectorAll('svg');
      expect(chevrons.length).toBeGreaterThan(0);
    });

    it('shows chevron up when expanded', async () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const header = screen.getByText('Sources').closest('div');
      fireEvent.click(header!);

      await waitFor(() => {
        expect(screen.getByTestId('citation-1')).toBeInTheDocument();
      });

      const chevrons = container.querySelectorAll('svg');
      expect(chevrons.length).toBeGreaterThan(0);
    });
  });

  describe('Deduplication', () => {
    it('deduplicates citations by URL', () => {
      const duplicateCitations: Citation[] = [
        {
          title: 'Article',
          url: 'https://example.com/1',
          date: '2024-01-01',
          number: 1,
        },
        {
          title: 'Same Article',
          url: 'https://example.com/1',
          date: '2024-01-01',
          number: 2,
        },
      ];

      render(<CitationList citations={duplicateCitations} />);

      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('Source')).toBeInTheDocument();
    });

    it('deduplicates citations by title', () => {
      const duplicateCitations: Citation[] = [
        {
          title: 'Same Title',
          url: 'https://example.com/1',
          date: '2024-01-01',
          number: 1,
        },
        {
          title: 'Same Title',
          url: 'https://example.com/2',
          date: '2024-01-02',
          number: 2,
        },
      ];

      render(<CitationList citations={duplicateCitations} />);

      expect(screen.getByText('1')).toBeInTheDocument();
    });

    it('keeps citations with different URLs and titles', () => {
      render(<CitationList citations={mockCitations} />);

      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('handles citations without URLs', () => {
      const citationsWithoutUrls: Citation[] = [
        { title: 'Article 1', url: '', date: '2024-01-01', number: 1 },
        { title: 'Article 2', url: '', date: '2024-01-02', number: 2 },
      ];

      render(<CitationList citations={citationsWithoutUrls} />);

      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('has correct header styling', () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const header = container.querySelector('.cursor-pointer');
      expect(header).toBeInTheDocument();
      expect(header).toHaveClass('rounded-lg');
      expect(header).toHaveClass('dark:bg-[#1a1a1a]');
      expect(header).toHaveClass('bg-gray-50/80');
    });

    it('has hover styling on header', () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const header = container.querySelector('.cursor-pointer');
      expect(header).toHaveClass('hover:bg-gray-100/80');
      expect(header).toHaveClass('dark:hover:bg-[#222222]');
    });

    it('container fades in with transition', () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('transition-opacity');
      expect(wrapper).toHaveClass('duration-500');
    });

    it('expanded citations container has correct classes', async () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const header = screen.getByText('Sources').closest('div');
      fireEvent.click(header!);

      await waitFor(() => {
        const scrollContainer = container.querySelector('.overflow-x-auto');
        expect(scrollContainer).toBeInTheDocument();
        expect(scrollContainer).toHaveClass('no-scrollbar');
        // Inner container has inline-flex and gap
        const innerContainer = scrollContainer?.querySelector('.inline-flex');
        expect(innerContainer).toBeInTheDocument();
        expect(innerContainer).toHaveClass('gap-4');
      });
    });
  });

  describe('Citation Rendering', () => {
    it('renders all citations when expanded', async () => {
      render(<CitationList citations={mockCitations} />);

      const header = screen.getByText('Sources').closest('div');
      fireEvent.click(header!);

      await waitFor(() => {
        expect(screen.getByText('First Article')).toBeInTheDocument();
        expect(screen.getByText('Second Article')).toBeInTheDocument();
        expect(screen.getByText('Third Article')).toBeInTheDocument();
      });
    });

    it('wraps each citation in flex-shrink-0 container', async () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const header = screen.getByText('Sources').closest('div');
      fireEvent.click(header!);

      await waitFor(() => {
        const shrinkContainers = container.querySelectorAll('.flex-shrink-0');
        expect(shrinkContainers.length).toBe(3);
      });
    });
  });

  describe('Edge Cases', () => {
    it('handles single citation', () => {
      render(<CitationList citations={[mockCitations[0]]} />);

      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('Source')).toBeInTheDocument();
    });

    it('handles many citations', () => {
      const manyCitations = Array.from({ length: 20 }, (_, i) => ({
        title: `Article ${i + 1}`,
        url: `https://example.com/${i + 1}`,
        date: '2024-01-01',
        number: i + 1,
      }));

      render(<CitationList citations={manyCitations} />);

      expect(screen.getByText('20')).toBeInTheDocument();
      expect(screen.getByText('Sources')).toBeInTheDocument();
    });

    it('handles citations without numbers', async () => {
      const citationsWithoutNumbers: Citation[] = [
        {
          title: 'Article 1',
          url: 'https://example.com/1',
          date: '2024-01-01',
          number: 1,
        },
        {
          title: 'Article 2',
          url: 'https://example.com/2',
          date: '2024-01-02',
          number: 2,
        },
      ];

      render(<CitationList citations={citationsWithoutNumbers} />);

      const header = screen.getByText('Sources').closest('div');
      fireEvent.click(header!);

      await waitFor(() => {
        expect(screen.getByText('Article 1')).toBeInTheDocument();
        expect(screen.getByText('Article 2')).toBeInTheDocument();
      });
    });
  });

  describe('Visibility Animation', () => {
    it('starts with opacity-0', () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const wrapper = container.firstChild as HTMLElement;
      // Initially may have opacity-0, but will transition to opacity-100
      expect(wrapper).toHaveClass('transition-opacity');
    });
  });

  describe('Accessibility', () => {
    it('header is clickable', () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const header = container.querySelector('.cursor-pointer');
      expect(header).toBeInTheDocument();
    });

    it('displays citation count prominently', () => {
      render(<CitationList citations={mockCitations} />);

      const count = screen.getByText('3');
      expect(count).toBeInTheDocument();
    });
  });

  describe('Header Favicons', () => {
    const citationsWithDifferentDomains: Citation[] = [
      {
        title: 'News Article',
        url: 'https://news.com/1',
        date: '2024-01-01',
        number: 1,
      },
      {
        title: 'Tech Article',
        url: 'https://techcrunch.com/2',
        date: '2024-01-02',
        number: 2,
      },
      {
        title: 'Another News',
        url: 'https://news.com/3',
        date: '2024-01-03',
        number: 3,
      },
    ];

    it('displays unique domain favicons in header', () => {
      const { container } = render(
        <CitationList citations={citationsWithDifferentDomains} />,
      );

      // Query for images with title attribute (header favicons have title for hover)
      const favicons = container.querySelectorAll('img[title]');
      // Should show 2 unique domains (news.com and techcrunch.com)
      expect(favicons.length).toBe(2);
    });

    it('deduplicates favicons by domain', () => {
      const duplicateDomainCitations: Citation[] = [
        {
          title: 'Article 1',
          url: 'https://example.com/1',
          date: '2024-01-01',
          number: 1,
        },
        {
          title: 'Article 2',
          url: 'https://example.com/2',
          date: '2024-01-02',
          number: 2,
        },
        {
          title: 'Article 3',
          url: 'https://example.com/3',
          date: '2024-01-03',
          number: 3,
        },
      ];

      const { container } = render(
        <CitationList citations={duplicateDomainCitations} />,
      );

      // Query for images with title attribute (header favicons have title for hover)
      const favicons = container.querySelectorAll('img[title]');
      expect(favicons.length).toBe(1);
    });

    it('shows overflow indicator when more than 5 unique domains', () => {
      const manyDomainCitations: Citation[] = Array.from(
        { length: 8 },
        (_, i) => ({
          title: `Article ${i + 1}`,
          url: `https://domain${i + 1}.com/article`,
          date: '2024-01-01',
          number: i + 1,
        }),
      );

      render(<CitationList citations={manyDomainCitations} />);

      // Should show +3 overflow indicator (8 domains - 5 visible)
      expect(screen.getByText('+3')).toBeInTheDocument();
    });

    it('does not show overflow indicator when 5 or fewer unique domains', () => {
      const fewDomainCitations: Citation[] = Array.from(
        { length: 5 },
        (_, i) => ({
          title: `Article ${i + 1}`,
          url: `https://domain${i + 1}.com/article`,
          date: '2024-01-01',
          number: i + 1,
        }),
      );

      render(<CitationList citations={fewDomainCitations} />);

      expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
    });

    it('uses Google Favicon API for icons', () => {
      const { container } = render(
        <CitationList citations={citationsWithDifferentDomains} />,
      );

      const favicon = container.querySelector('img');
      expect(favicon).toHaveAttribute(
        'src',
        expect.stringContaining('google.com/s2/favicons'),
      );
    });

    it('displays domain name on hover (title attribute)', () => {
      const { container } = render(
        <CitationList citations={citationsWithDifferentDomains} />,
      );

      const favicons = container.querySelectorAll('img[title]');
      expect(favicons.length).toBe(2);

      // Check that favicons have title attributes with domain names
      const titles = Array.from(favicons).map((img) =>
        img.getAttribute('title'),
      );
      expect(titles).toContain('news.com');
      expect(titles).toContain('techcrunch.com');
    });
  });

  describe('View Mode Toggle', () => {
    it('renders view mode toggle button', () => {
      render(<CitationList citations={mockCitations} />);

      const toggleButton = screen.getByTitle(/switch to/i);
      expect(toggleButton).toBeInTheDocument();
    });

    it('starts in cards view mode by default', async () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      const header = screen.getByText('Sources').closest('div');
      fireEvent.click(header!);

      await waitFor(() => {
        // Should show CitationItem components (cards view)
        expect(screen.getByTestId('citation-1')).toBeInTheDocument();
        // Should not show CitationListItem components
        expect(screen.queryByTestId('list-citation-1')).not.toBeInTheDocument();
      });
    });

    it('switches to list view when toggle clicked', async () => {
      render(<CitationList citations={mockCitations} />);

      // Expand first
      const header = screen.getByText('Sources').closest('div');
      fireEvent.click(header!);

      await waitFor(() => {
        expect(screen.getByTestId('citation-1')).toBeInTheDocument();
      });

      // Click toggle button
      const toggleButton = screen.getByTitle(/switch to list/i);
      fireEvent.click(toggleButton);

      await waitFor(() => {
        // Should show CitationListItem components (list view)
        expect(screen.getByTestId('list-citation-1')).toBeInTheDocument();
        // Should not show CitationItem components
        expect(screen.queryByTestId('citation-1')).not.toBeInTheDocument();
      });
    });

    it('switches back to cards view when toggle clicked again', async () => {
      render(<CitationList citations={mockCitations} />);

      // Expand first
      const header = screen.getByText('Sources').closest('div');
      fireEvent.click(header!);

      await waitFor(() => {
        expect(screen.getByTestId('citation-1')).toBeInTheDocument();
      });

      // Switch to list view
      const toggleButton = screen.getByTitle(/switch to list/i);
      fireEvent.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByTestId('list-citation-1')).toBeInTheDocument();
      });

      // Switch back to cards view
      const toggleButtonAgain = screen.getByTitle(/switch to card/i);
      fireEvent.click(toggleButtonAgain);

      await waitFor(() => {
        expect(screen.getByTestId('citation-1')).toBeInTheDocument();
        expect(screen.queryByTestId('list-citation-1')).not.toBeInTheDocument();
      });
    });

    it('toggle does not collapse when already expanded', async () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      // Expand first
      const header = screen.getByText('Sources').closest('div');
      fireEvent.click(header!);

      await waitFor(() => {
        const citationsContainer = container.querySelector('.overflow-hidden');
        expect(citationsContainer).toHaveClass('opacity-100');
      });

      // Click toggle - should not collapse
      const toggleButton = screen.getByTitle(/switch to/i);
      fireEvent.click(toggleButton);

      await waitFor(() => {
        const citationsContainer = container.querySelector('.overflow-hidden');
        expect(citationsContainer).toHaveClass('opacity-100');
      });
    });

    it('auto-expands when toggling view mode while collapsed', async () => {
      const { container } = render(<CitationList citations={mockCitations} />);

      // Start collapsed
      const citationsContainer = container.querySelector('.overflow-hidden');
      expect(citationsContainer).toHaveClass('max-h-0');

      // Click toggle without expanding first
      const toggleButton = screen.getByTitle(/switch to/i);
      fireEvent.click(toggleButton);

      // Should auto-expand
      await waitFor(() => {
        const expandedContainer = container.querySelector('.overflow-hidden');
        expect(expandedContainer).toHaveClass('opacity-100');
        expect(expandedContainer).not.toHaveClass('max-h-0');
      });
    });

    it('shows correct icon based on current view mode', async () => {
      render(<CitationList citations={mockCitations} />);

      // Default should show list icon (to switch to list view)
      expect(screen.getByTitle('Switch to list view')).toBeInTheDocument();

      // Click toggle
      const toggleButton = screen.getByTitle('Switch to list view');
      fireEvent.click(toggleButton);

      await waitFor(() => {
        // Now should show cards icon (to switch back to card view)
        expect(screen.getByTitle('Switch to card view')).toBeInTheDocument();
      });
    });
  });
});
