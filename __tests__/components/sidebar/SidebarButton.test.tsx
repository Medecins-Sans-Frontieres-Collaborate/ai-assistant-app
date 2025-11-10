import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { SidebarButton } from '@/components/Sidebar/SidebarButton';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

describe('SidebarButton', () => {
  const mockIcon = <svg data-testid="test-icon">Icon</svg>;

  it('renders button with text', () => {
    const mockOnClick = vi.fn();
    render(
      <SidebarButton
        text="Test Button"
        icon={mockIcon}
        onClick={mockOnClick}
      />,
    );

    const buttonText = screen.getByText('Test Button');
    expect(buttonText).toBeInTheDocument();
  });

  it('renders icon', () => {
    const mockOnClick = vi.fn();
    render(<SidebarButton text="Test" icon={mockIcon} onClick={mockOnClick} />);

    const icon = screen.getByTestId('test-icon');
    expect(icon).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const mockOnClick = vi.fn();
    render(
      <SidebarButton text="Clickable" icon={mockIcon} onClick={mockOnClick} />,
    );

    const button = screen.getByRole('button');
    fireEvent.click(button);

    expect(mockOnClick).toHaveBeenCalledTimes(1);
  });

  it('calls onClick multiple times', () => {
    const mockOnClick = vi.fn();
    render(
      <SidebarButton
        text="Multi Click"
        icon={mockIcon}
        onClick={mockOnClick}
      />,
    );

    const button = screen.getByRole('button');
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(mockOnClick).toHaveBeenCalledTimes(3);
  });

  it('has correct styling classes', () => {
    const mockOnClick = vi.fn();
    render(
      <SidebarButton text="Styled" icon={mockIcon} onClick={mockOnClick} />,
    );

    const button = screen.getByRole('button');
    expect(button).toHaveClass('flex');
    expect(button).toHaveClass('w-full');
    expect(button).toHaveClass('cursor-pointer');
    expect(button).toHaveClass('select-none');
    expect(button).toHaveClass('items-center');
    expect(button).toHaveClass('gap-3');
    expect(button).toHaveClass('rounded-md');
  });

  it('renders text in a span element', () => {
    const mockOnClick = vi.fn();
    const { container } = render(
      <SidebarButton text="Span Text" icon={mockIcon} onClick={mockOnClick} />,
    );

    const span = container.querySelector('span');
    expect(span).toBeInTheDocument();
    expect(span?.textContent).toBe('Span Text');
  });

  it('renders icon in a div element', () => {
    const mockOnClick = vi.fn();
    const { container } = render(
      <SidebarButton text="Icon Test" icon={mockIcon} onClick={mockOnClick} />,
    );

    const iconDiv = container.querySelector('div');
    expect(iconDiv).toBeInTheDocument();
    expect(iconDiv).toContainElement(screen.getByTestId('test-icon'));
  });

  it('renders with different text values', () => {
    const mockOnClick = vi.fn();

    const { rerender } = render(
      <SidebarButton text="First" icon={mockIcon} onClick={mockOnClick} />,
    );
    expect(screen.getByText('First')).toBeInTheDocument();

    rerender(
      <SidebarButton text="Second" icon={mockIcon} onClick={mockOnClick} />,
    );
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.queryByText('First')).not.toBeInTheDocument();
  });

  it('renders with different icons', () => {
    const mockOnClick = vi.fn();
    const icon1 = <svg data-testid="icon-1">Icon 1</svg>;
    const icon2 = <svg data-testid="icon-2">Icon 2</svg>;

    const { rerender } = render(
      <SidebarButton text="Test" icon={icon1} onClick={mockOnClick} />,
    );
    expect(screen.getByTestId('icon-1')).toBeInTheDocument();

    rerender(<SidebarButton text="Test" icon={icon2} onClick={mockOnClick} />);
    expect(screen.getByTestId('icon-2')).toBeInTheDocument();
    expect(screen.queryByTestId('icon-1')).not.toBeInTheDocument();
  });

  it('handles empty text gracefully', () => {
    const mockOnClick = vi.fn();
    render(<SidebarButton text="" icon={mockIcon} onClick={mockOnClick} />);

    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();

    const span = button.querySelector('span');
    expect(span?.textContent).toBe('');
  });

  it('matches snapshot', () => {
    const mockOnClick = vi.fn();
    const { container } = render(
      <SidebarButton
        text="Snapshot Test"
        icon={mockIcon}
        onClick={mockOnClick}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});
