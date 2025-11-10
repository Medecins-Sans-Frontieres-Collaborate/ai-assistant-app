import { render, screen } from '@testing-library/react';
import React from 'react';

import { EmptyState } from '@/components/Chat/EmptyState/EmptyState';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
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
    expect(heading).toHaveClass('text-2xl');
    expect(heading).toHaveClass('font-light');
    expect(heading).toHaveClass('bg-gradient-to-r');
    expect(heading).toHaveClass('bg-clip-text');
    expect(heading).toHaveClass('text-transparent');
  });
});
