import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { NavigationItem } from '@/components/Settings/NavigationItem';
import { SettingsSection } from '@/components/Settings/types';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('NavigationItem', () => {
  const mockOnClick = vi.fn();

  beforeEach(() => {
    mockOnClick.mockClear();
  });

  describe('Rendering', () => {
    it('renders navigation item with label', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      expect(screen.getByText('General Settings')).toBeInTheDocument();
    });

    it('renders navigation item with icon', () => {
      const TestIcon = () => <svg data-testid="test-icon" />;

      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          icon={<TestIcon />}
          onClick={mockOnClick}
        />,
      );

      expect(screen.getByTestId('test-icon')).toBeInTheDocument();
    });

    it('renders without icon when not provided', () => {
      const { container } = render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const iconSpan = container.querySelector('.mr-3');
      expect(iconSpan).not.toBeInTheDocument();
    });

    it('renders as button element', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
    });
  });

  describe('Active State', () => {
    it('applies active styling when section matches activeSection', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-gray-200');
      expect(button).toHaveClass('dark:bg-gray-700');
      expect(button).toHaveClass('font-semibold');
    });

    it('applies inactive styling when section does not match activeSection', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.CHAT_SETTINGS}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('hover:bg-gray-100');
      expect(button).toHaveClass('dark:hover:bg-gray-800');
      expect(button).not.toHaveClass('bg-gray-200');
      expect(button).not.toHaveClass('font-semibold');
    });

    it('sets aria-current when active', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-current', 'page');
    });

    it('does not set aria-current when inactive', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.CHAT_SETTINGS}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      expect(button).not.toHaveAttribute('aria-current');
    });
  });

  describe('Click Behavior', () => {
    it('calls onClick with section when clicked', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.CHAT_SETTINGS}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(1);
      expect(mockOnClick).toHaveBeenCalledWith(SettingsSection.GENERAL);
    });

    it('calls onClick even when active', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(1);
      expect(mockOnClick).toHaveBeenCalledWith(SettingsSection.GENERAL);
    });

    it('calls onClick with correct section for different sections', () => {
      render(
        <NavigationItem
          section={SettingsSection.DATA_MANAGEMENT}
          activeSection={SettingsSection.GENERAL}
          label="Data Management"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(mockOnClick).toHaveBeenCalledWith(SettingsSection.DATA_MANAGEMENT);
    });
  });

  describe('Styling', () => {
    it('has full width', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('w-full');
    });

    it('has text-left alignment', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('text-left');
    });

    it('has rounded corners', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('rounded-lg');
    });

    it('has flex layout with items-center', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General Settings"
          onClick={mockOnClick}
        />,
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('flex');
      expect(button).toHaveClass('items-center');
    });
  });

  describe('All SettingsSections', () => {
    it('works with GENERAL section', () => {
      render(
        <NavigationItem
          section={SettingsSection.GENERAL}
          activeSection={SettingsSection.GENERAL}
          label="General"
          onClick={mockOnClick}
        />,
      );

      expect(screen.getByText('General')).toBeInTheDocument();
    });

    it('works with CHAT_SETTINGS section', () => {
      render(
        <NavigationItem
          section={SettingsSection.CHAT_SETTINGS}
          activeSection={SettingsSection.CHAT_SETTINGS}
          label="Chat Settings"
          onClick={mockOnClick}
        />,
      );

      expect(screen.getByText('Chat Settings')).toBeInTheDocument();
    });

    it('works with DATA_MANAGEMENT section', () => {
      render(
        <NavigationItem
          section={SettingsSection.DATA_MANAGEMENT}
          activeSection={SettingsSection.DATA_MANAGEMENT}
          label="Data Management"
          onClick={mockOnClick}
        />,
      );

      expect(screen.getByText('Data Management')).toBeInTheDocument();
    });

    it('works with ACCOUNT section', () => {
      render(
        <NavigationItem
          section={SettingsSection.ACCOUNT}
          activeSection={SettingsSection.ACCOUNT}
          label="Account"
          onClick={mockOnClick}
        />,
      );

      expect(screen.getByText('Account')).toBeInTheDocument();
    });
  });
});
