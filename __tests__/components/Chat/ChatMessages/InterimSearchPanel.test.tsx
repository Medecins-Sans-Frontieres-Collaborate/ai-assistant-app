import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { InterimSearchPanel } from '@/components/Chat/ChatMessages/InterimSearchPanel';

import { useChatStore } from '@/client/stores/chatStore';
import type { SearchInterimPayload } from '@/lib/streamMarkers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const interim: SearchInterimPayload = {
  queries: ['fusion energy'],
  entries: [
    {
      title: 'Headline A',
      url: 'https://a.example/1',
      date: '2026-07-23',
      sourceName: 'a.example',
    },
    {
      title: 'Headline B',
      url: 'https://b.example/2',
      date: '2026-07-23',
    },
  ],
};

describe('InterimSearchPanel', () => {
  let summarizeFromHeadlines: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    summarizeFromHeadlines = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      summarizeFromHeadlines,
    } as never);
  });

  it('renders the headlines with their source links', () => {
    render(<InterimSearchPanel interim={interim} />);

    expect(screen.getByText('Headline A')).toBeInTheDocument();
    expect(screen.getByText('Headline B')).toBeInTheDocument();
    const link = screen.getByText('Headline A').closest('a');
    expect(link).toHaveAttribute('href', 'https://a.example/1');
  });

  it('triggers the resend once and disables the button against double clicks', () => {
    render(<InterimSearchPanel interim={interim} />);

    const button = screen.getByRole('button', {
      name: /Summarize from headlines now/,
    });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(summarizeFromHeadlines).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
  });

  it('renders nothing when the payload has no entries', () => {
    const { container } = render(
      <InterimSearchPanel interim={{ queries: ['q'], entries: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('collapses long lists behind a "Show all" toggle', () => {
    const many: SearchInterimPayload = {
      queries: ['q'],
      entries: Array.from({ length: 9 }, (_, i) => ({
        title: `Headline ${i + 1}`,
        url: `https://example.com/${i + 1}`,
        date: '2026-07-23',
      })),
    };
    render(<InterimSearchPanel interim={many} />);

    // Only the first 6 render initially.
    expect(screen.getByText('Headline 6')).toBeInTheDocument();
    expect(screen.queryByText('Headline 7')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /Show all 9 sources/ });
    fireEvent.click(toggle);
    expect(screen.getByText('Headline 9')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show fewer/ }));
    expect(screen.queryByText('Headline 9')).not.toBeInTheDocument();
    expect(screen.getByText('Headline 6')).toBeInTheDocument();
  });

  it('shows no toggle when everything already fits', () => {
    render(<InterimSearchPanel interim={interim} />);
    expect(
      screen.queryByRole('button', { name: /Show all/ }),
    ).not.toBeInTheDocument();
  });
});
