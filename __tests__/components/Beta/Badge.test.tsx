import { render, screen } from '@testing-library/react';
import React from 'react';

import BetaBadge from '@/components/Beta/Badge';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

describe('BetaBadge', () => {
  it('renders beta text', () => {
    render(<BetaBadge />);

    const badgeText = screen.getByText('Beta');
    expect(badgeText).toBeInTheDocument();
  });

  it('renders as a span element', () => {
    const { container } = render(<BetaBadge />);

    const span = container.querySelector('span');
    expect(span).toBeInTheDocument();
    expect(span?.textContent).toBe('Beta');
  });

  it('has correct styling classes', () => {
    const { container } = render(<BetaBadge />);

    const span = container.querySelector('span');
    expect(span).toHaveClass('items-center');
    expect(span).toHaveClass('px-2');
    expect(span).toHaveClass('py-0.5');
    expect(span).toHaveClass('rounded-full');
    expect(span).toHaveClass('text-xs');
    expect(span).toHaveClass('font-medium');
    expect(span).toHaveClass('bg-yellow-100');
    expect(span).toHaveClass('text-yellow-800');
  });

  it('matches snapshot', () => {
    const { container } = render(<BetaBadge />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
