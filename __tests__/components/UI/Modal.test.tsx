import React from 'react';

import Modal from '@/components/UI/Modal';

import { fireEvent, render, screen } from '@/__tests__/testUtils';
import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

describe('Modal', () => {
  it('does not render when isOpen is false', () => {
    const mockOnClose = vi.fn();
    const { container } = render(
      <Modal isOpen={false} onClose={mockOnClose}>
        <div>Modal Content</div>
      </Modal>,
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders when isOpen is true', () => {
    const mockOnClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={mockOnClose}>
        <div>Modal Content</div>
      </Modal>,
    );

    expect(screen.getByText('Modal Content')).toBeInTheDocument();
  });

  it('renders title when provided', () => {
    const mockOnClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={mockOnClose} title="Test Modal Title">
        <div>Content</div>
      </Modal>,
    );

    expect(screen.getByText('Test Modal Title')).toBeInTheDocument();
  });

  it('renders with different size classes', () => {
    const mockOnClose = vi.fn();

    const { rerender } = render(
      <Modal isOpen={true} onClose={mockOnClose} size="sm">
        <div>Content</div>
      </Modal>,
    );

    let modalContainer = document.body.querySelector('[role="dialog"]');
    expect(modalContainer).toHaveClass('max-w-sm');

    rerender(
      <Modal isOpen={true} onClose={mockOnClose} size="lg">
        <div>Content</div>
      </Modal>,
    );

    modalContainer = document.body.querySelector('[role="dialog"]');
    expect(modalContainer).toHaveClass('max-w-2xl');

    rerender(
      <Modal isOpen={true} onClose={mockOnClose} size="xl">
        <div>Content</div>
      </Modal>,
    );

    modalContainer = document.body.querySelector('[role="dialog"]');
    expect(modalContainer).toHaveClass('max-w-4xl');
  });

  it('renders close button by default', () => {
    const mockOnClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={mockOnClose} title="Test">
        <div>Content</div>
      </Modal>,
    );

    const closeButton = screen.getByLabelText('Close modal');
    expect(closeButton).toBeInTheDocument();
  });

  it('does not render close button when showCloseButton is false', () => {
    const mockOnClose = vi.fn();
    render(
      <Modal
        isOpen={true}
        onClose={mockOnClose}
        showCloseButton={false}
        title="Test"
      >
        <div>Content</div>
      </Modal>,
    );

    const closeButton = screen.queryByLabelText('Close modal');
    expect(closeButton).not.toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const mockOnClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={mockOnClose} title="Test">
        <div>Content</div>
      </Modal>,
    );

    const closeButton = screen.getByLabelText('Close modal');
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const mockOnClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={mockOnClose}>
        <div>Content</div>
      </Modal>,
    );

    const backdrop = document.body.querySelector('.bg-black.bg-opacity-40');
    expect(backdrop).toBeInTheDocument();

    if (backdrop) {
      fireEvent.click(backdrop);
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    }
  });

  it('does not call onClose when backdrop is clicked if preventOutsideClick is true', () => {
    const mockOnClose = vi.fn();
    const { container } = render(
      <Modal isOpen={true} onClose={mockOnClose} preventOutsideClick={true}>
        <div>Content</div>
      </Modal>,
    );

    const backdrop = container.querySelector('.bg-black.bg-opacity-40');
    if (backdrop) {
      fireEvent.click(backdrop);
      expect(mockOnClose).not.toHaveBeenCalled();
    }
  });

  it('renders footer when provided', () => {
    const mockOnClose = vi.fn();
    const footer = <div>Footer Content</div>;

    render(
      <Modal isOpen={true} onClose={mockOnClose} footer={footer}>
        <div>Content</div>
      </Modal>,
    );

    expect(screen.getByText('Footer Content')).toBeInTheDocument();
  });

  it('renders icon when provided', () => {
    const mockOnClose = vi.fn();
    const icon = <svg data-testid="modal-icon">Icon</svg>;

    render(
      <Modal isOpen={true} onClose={mockOnClose} icon={icon} title="Test">
        <div>Content</div>
      </Modal>,
    );

    expect(screen.getByTestId('modal-icon')).toBeInTheDocument();
  });

  it('renders beta badge when provided', () => {
    const mockOnClose = vi.fn();
    const betaBadge = <span data-testid="beta-badge">Beta</span>;

    render(
      <Modal isOpen={true} onClose={mockOnClose} betaBadge={betaBadge}>
        <div>Content</div>
      </Modal>,
    );

    expect(screen.getByTestId('beta-badge')).toBeInTheDocument();
  });

  it('has correct aria attributes', () => {
    const mockOnClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={mockOnClose} title="Test Modal">
        <div>Content</div>
      </Modal>,
    );

    const modal = document.body.querySelector('[role="dialog"]');
    expect(modal).toHaveAttribute('aria-modal', 'true');
    expect(modal).toHaveAttribute('aria-labelledby', 'modal-title');
  });

  it('renders children content', () => {
    const mockOnClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={mockOnClose}>
        <div>
          <p>First paragraph</p>
          <p>Second paragraph</p>
        </div>
      </Modal>,
    );

    expect(screen.getByText('First paragraph')).toBeInTheDocument();
    expect(screen.getByText('Second paragraph')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const mockOnClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={mockOnClose} className="custom-modal-class">
        <div>Content</div>
      </Modal>,
    );

    // The className is applied to the modal dialog
    const modal = document.body.querySelector('[role="dialog"]');
    expect(modal?.className).toContain('custom-modal-class');
  });

  it('applies custom contentClassName', () => {
    const mockOnClose = vi.fn();
    render(
      <Modal
        isOpen={true}
        onClose={mockOnClose}
        contentClassName="custom-content-class"
      >
        <div>Content</div>
      </Modal>,
    );

    const contentDiv = document.body.querySelector('.modal-content');
    expect(contentDiv).toHaveClass('custom-content-class');
  });

  it('moves initial focus to initialFocusRef when provided', () => {
    const Wrapper = () => {
      const inputRef = React.useRef<HTMLInputElement>(null);
      return (
        <Modal isOpen={true} onClose={vi.fn()} initialFocusRef={inputRef}>
          <button>Other</button>
          <input ref={inputRef} data-testid="target-input" />
        </Modal>
      );
    };

    render(<Wrapper />);

    expect(screen.getByTestId('target-input')).toHaveFocus();
  });

  it('falls back to the first focusable element when initialFocusRef is absent', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} showCloseButton={false}>
        <button>First Action</button>
        <button>Second Action</button>
      </Modal>,
    );

    expect(screen.getByText('First Action')).toHaveFocus();
  });

  it('focuses the panel itself when nothing inside is focusable', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} showCloseButton={false}>
        <p>Plain text</p>
      </Modal>,
    );

    expect(document.body.querySelector('[role="dialog"]')).toHaveFocus();
  });

  it('cycles Tab focus within the modal', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} showCloseButton={false}>
        <button>First Action</button>
        <button>Last Action</button>
      </Modal>,
    );

    const first = screen.getByText('First Action');
    const last = screen.getByText('Last Action');

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('restores focus to the previously focused element when the modal closes', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test">
        <button>Inside</button>
      </Modal>,
    );

    expect(trigger).not.toHaveFocus();

    rerender(
      <Modal isOpen={false} onClose={vi.fn()} title="Test">
        <button>Inside</button>
      </Modal>,
    );

    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('marks its portal root as a settings portal so stacked dialogs do not close settings', () => {
    // The settings dialog closes on any mousedown outside its own DOM tree.
    // Modals portal to document.body, so without this attribute clicking a
    // confirm button inside a modal opened FROM settings closed the whole
    // settings dialog before the button's handler could run.
    render(
      <Modal isOpen={true} onClose={vi.fn()}>
        <div>Content</div>
      </Modal>,
    );

    const portalRoot = document.body.querySelector('[data-settings-portal]');
    expect(portalRoot).not.toBeNull();
    expect(portalRoot).toContainElement(
      document.body.querySelector('.modal-content') as HTMLElement,
    );
  });
});
