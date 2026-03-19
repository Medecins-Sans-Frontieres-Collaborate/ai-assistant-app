import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { TabEmptyState } from '@/components/QuickActions/TabEmptyState';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

describe('TabEmptyState', () => {
  const defaultProps = {
    title: 'Test Title',
    subtitle: 'Test Subtitle',
    sectionIcon: <span data-testid="section-icon">icon</span>,
    sectionTitle: 'Section Title',
    tipIcon: <span data-testid="tip-icon">/</span>,
    tipText: 'Tip text here',
    ctaIcon: <span data-testid="cta-icon">+</span>,
    ctaLabel: 'Create Item',
    onCtaClick: vi.fn(),
    children: <div data-testid="custom-content">Custom content</div>,
  };

  it('renders title and subtitle', () => {
    render(<TabEmptyState {...defaultProps} />);

    expect(screen.getByText('Test Title')).toBeInTheDocument();
    expect(screen.getByText('Test Subtitle')).toBeInTheDocument();
  });

  it('renders section header with icon and title', () => {
    render(<TabEmptyState {...defaultProps} />);

    expect(screen.getByTestId('section-icon')).toBeInTheDocument();
    expect(screen.getByText('Section Title')).toBeInTheDocument();
  });

  it('renders children in the section body', () => {
    render(<TabEmptyState {...defaultProps} />);

    expect(screen.getByTestId('custom-content')).toBeInTheDocument();
    expect(screen.getByText('Custom content')).toBeInTheDocument();
  });

  it('renders tip text with icon', () => {
    render(<TabEmptyState {...defaultProps} />);

    expect(screen.getByTestId('tip-icon')).toBeInTheDocument();
    expect(screen.getByText('Tip text here')).toBeInTheDocument();
  });

  it('renders CTA button with label and icon', () => {
    render(<TabEmptyState {...defaultProps} />);

    const button = screen.getByRole('button', { name: /Create Item/ });
    expect(button).toBeInTheDocument();
    expect(screen.getByTestId('cta-icon')).toBeInTheDocument();
  });

  it('calls onCtaClick when CTA button is clicked', () => {
    const onCtaClick = vi.fn();
    render(<TabEmptyState {...defaultProps} onCtaClick={onCtaClick} />);

    fireEvent.click(screen.getByRole('button', { name: /Create Item/ }));
    expect(onCtaClick).toHaveBeenCalledOnce();
  });
});
