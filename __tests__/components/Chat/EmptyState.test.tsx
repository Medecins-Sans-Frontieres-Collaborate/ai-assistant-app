import { render, screen } from '@testing-library/react';
import React from 'react';

import { EmptyState } from '@/components/Chat/EmptyState/EmptyState';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Mock next-intl with interpolation support
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) => {
    const messages: Record<string, string> = {
      greeting: 'How can I help?',
      greetingWithName: 'How can I help, {name}?',
    };
    let message = messages[key] || key;
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        message = message.replace(`{${k}}`, v);
      });
    }
    return message;
  },
}));

describe('EmptyState', () => {
  it('renders empty state', () => {
    const { container } = render(<EmptyState />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('renders greeting heading', () => {
    render(<EmptyState />);

    const heading = screen.getByRole('heading');
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent('How can I help?');
  });

  it('displays user name when provided', () => {
    render(<EmptyState userName="John" />);

    const heading = screen.getByRole('heading');
    expect(heading).toHaveTextContent('How can I help, John?');
  });

  it('has correct layout structure', () => {
    const { container } = render(<EmptyState />);

    const wrapper = container.firstChild;
    expect(wrapper).toHaveClass('flex');
    expect(wrapper).toHaveClass('items-center');
    expect(wrapper).toHaveClass('justify-center');
  });

  it('centers content vertically and horizontally', () => {
    const { container } = render(<EmptyState />);

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('items-center');
    expect(wrapper).toHaveClass('justify-center');
  });

  it('heading has correct styling', () => {
    render(<EmptyState />);

    const heading = screen.getByRole('heading');
    // Steps down on narrow viewports — a long greetingWithName overflowed at
    // 320-360px at a flat text-2xl.
    expect(heading).toHaveClass('text-xl');
    expect(heading).toHaveClass('sm:text-2xl');
    expect(heading).toHaveClass('font-light');
    expect(heading).toHaveClass('bg-gradient-to-r');
    expect(heading).toHaveClass('bg-clip-text');
    expect(heading).toHaveClass('text-transparent');
  });
});
