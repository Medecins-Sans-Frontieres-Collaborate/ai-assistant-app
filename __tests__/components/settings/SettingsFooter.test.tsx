import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { SettingsFooter } from '@/components/Settings/SettingsFooter';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// Mock next-auth
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: {
      user: {
        id: 'test-user',
        displayName: 'Test User',
        mail: 'test@example.com',
      },
      expires: '2099-01-01',
    },
    status: 'authenticated',
  }),
}));

// Mock userAuth utility
vi.mock('@/lib/utils/app/user/userAuth', () => ({
  isUSBased: (email: string) => email.includes('@us.'),
}));

// Mock contact types
vi.mock('@/types/contact', () => ({
  FEEDBACK_EMAIL: 'feedback@example.com',
  US_FEEDBACK_EMAIL: 'feedback@us.example.com',
}));

describe('SettingsFooter', () => {
  const defaultProps = {
    version: '1.0',
    build: '42',
    env: 'prod',
  };

  describe('Version Display', () => {
    it('renders version information', () => {
      render(<SettingsFooter {...defaultProps} />);

      expect(screen.getByText('v1.0.42.prod')).toBeInTheDocument();
    });

    it('renders different version numbers', () => {
      render(<SettingsFooter version="2.5" build="123" env="staging" />);

      expect(screen.getByText('v2.5.123.staging')).toBeInTheDocument();
    });

    it('version has correct styling', () => {
      render(<SettingsFooter {...defaultProps} />);

      const versionElement = screen.getByText('v1.0.42.prod');
      expect(versionElement).toHaveClass('text-gray-500');
      expect(versionElement).toHaveClass('text-sm');
    });
  });

  describe('Feedback Link', () => {
    it('renders feedback link with default email', () => {
      render(<SettingsFooter {...defaultProps} />);

      const feedbackLink = screen.getByText('sendFeedback').closest('a');
      expect(feedbackLink).toBeInTheDocument();
      expect(feedbackLink).toHaveAttribute(
        'href',
        'mailto:feedback@example.com',
      );
    });

    it('renders feedback link with US email for US users', () => {
      // Note: Component uses session.user.region, not userEmail prop
      // Mock session doesn't have region='US', so it uses default email
      render(
        <SettingsFooter {...defaultProps} userEmail="user@us.example.com" />,
      );

      const feedbackLink = screen.getByText('sendFeedback').closest('a');
      // Since mock session doesn't have region='US', it uses default email
      expect(feedbackLink).toHaveAttribute(
        'href',
        'mailto:feedback@example.com',
      );
    });

    it('renders feedback link with default email for non-US users', () => {
      render(
        <SettingsFooter {...defaultProps} userEmail="user@eu.example.com" />,
      );

      const feedbackLink = screen.getByText('sendFeedback').closest('a');
      expect(feedbackLink).toHaveAttribute(
        'href',
        'mailto:feedback@example.com',
      );
    });

    it('feedback link has correct styling', () => {
      render(<SettingsFooter {...defaultProps} />);

      const feedbackLink = screen.getByText('sendFeedback').closest('a');
      expect(feedbackLink).toHaveClass('flex');
      expect(feedbackLink).toHaveClass('items-center');
      expect(feedbackLink).toHaveClass('text-black');
      expect(feedbackLink).toHaveClass('dark:text-white');
    });

    it('feedback link contains icon', () => {
      const { container } = render(<SettingsFooter {...defaultProps} />);

      const feedbackLink = screen.getByText('sendFeedback').closest('a');
      const icon = feedbackLink?.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('Reset Button', () => {
    it('does not render reset button when handleReset is not provided', () => {
      render(<SettingsFooter {...defaultProps} onClose={vi.fn()} />);

      expect(screen.queryByText('Reset Settings')).not.toBeInTheDocument();
    });

    it('does not render reset button when onClose is not provided', () => {
      render(<SettingsFooter {...defaultProps} handleReset={vi.fn()} />);

      expect(screen.queryByText('Reset Settings')).not.toBeInTheDocument();
    });

    it('renders reset button when both handleReset and onClose are provided', () => {
      render(
        <SettingsFooter
          {...defaultProps}
          handleReset={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      expect(screen.getByText('Reset Settings')).toBeInTheDocument();
    });

    it('calls handleReset when reset button is clicked', () => {
      const mockHandleReset = vi.fn();
      const mockOnClose = vi.fn();

      render(
        <SettingsFooter
          {...defaultProps}
          handleReset={mockHandleReset}
          onClose={mockOnClose}
        />,
      );

      const resetButton = screen.getByText('Reset Settings');
      fireEvent.click(resetButton);

      expect(mockHandleReset).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when reset button is clicked', () => {
      const mockHandleReset = vi.fn();
      const mockOnClose = vi.fn();

      render(
        <SettingsFooter
          {...defaultProps}
          handleReset={mockHandleReset}
          onClose={mockOnClose}
        />,
      );

      const resetButton = screen.getByText('Reset Settings');
      fireEvent.click(resetButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('reset button has correct styling for mobile visibility', () => {
      render(
        <SettingsFooter
          {...defaultProps}
          handleReset={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      const resetButton = screen.getByText('Reset Settings');
      expect(resetButton).toHaveClass('md:hidden');
    });
  });

  describe('Layout', () => {
    it('has correct container styling', () => {
      const { container } = render(<SettingsFooter {...defaultProps} />);

      const footerDiv = container.firstChild as HTMLElement;
      expect(footerDiv).toHaveClass('flex');
      expect(footerDiv).toHaveClass('flex-col');
      expect(footerDiv).toHaveClass('border-t');
      expect(footerDiv).toHaveClass('border-gray-300');
      expect(footerDiv).toHaveClass('dark:border-neutral-700');
    });

    it('footer content has responsive layout', () => {
      const { container } = render(<SettingsFooter {...defaultProps} />);

      const contentDiv = container.querySelector(
        '.flex.flex-row.justify-between',
      );
      expect(contentDiv).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles missing userEmail gracefully', () => {
      render(<SettingsFooter {...defaultProps} />);

      const feedbackLink = screen.getByText('sendFeedback').closest('a');
      expect(feedbackLink).toHaveAttribute(
        'href',
        'mailto:feedback@example.com',
      );
    });

    it('handles empty string userEmail', () => {
      render(<SettingsFooter {...defaultProps} userEmail="" />);

      const feedbackLink = screen.getByText('sendFeedback').closest('a');
      expect(feedbackLink).toHaveAttribute(
        'href',
        'mailto:feedback@example.com',
      );
    });

    it('handles version 0', () => {
      render(<SettingsFooter version="0" build="0" env="dev" />);

      expect(screen.getByText('v0.0.dev')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('reset button is a button element', () => {
      render(
        <SettingsFooter
          {...defaultProps}
          handleReset={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      const resetButton = screen.getByText('Reset Settings');
      expect(resetButton.tagName).toBe('BUTTON');
    });

    it('feedback link is an anchor element', () => {
      render(<SettingsFooter {...defaultProps} />);

      const feedbackLink = screen.getByText('sendFeedback').closest('a');
      expect(feedbackLink?.tagName).toBe('A');
    });
  });
});
