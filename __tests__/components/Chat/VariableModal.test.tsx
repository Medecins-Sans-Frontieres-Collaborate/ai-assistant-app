import React from 'react';

import { Prompt } from '@/types/prompt';

import { VariableModal } from '@/components/Chat/ChatInput/VariableModal';

import { fireEvent, render, screen, waitFor } from '@/__tests__/testUtils';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('VariableModal', () => {
  const mockOnSubmit = vi.fn();
  const mockOnClose = vi.fn();

  const mockModel = {
    id: 'gpt-4.1' as const,
    name: 'GPT-4 Turbo',
    maxLength: 128000,
    tokenLimit: 128000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering with required variables', () => {
    const promptWithRequired: Prompt = {
      id: 'test-1',
      name: 'Test Prompt',
      description: 'A test prompt',
      content: 'Hello {{name}}, your age is {{age}}',
      model: mockModel,
      folderId: null,
    };

    it('renders prompt name and description', () => {
      render(
        <VariableModal
          prompt={promptWithRequired}
          variables={['name', 'age']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      expect(screen.getByText('Test Prompt')).toBeInTheDocument();
      expect(screen.getByText('A test prompt')).toBeInTheDocument();
    });

    it('shows required badges for variables without defaults', () => {
      render(
        <VariableModal
          prompt={promptWithRequired}
          variables={['name', 'age']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      const requiredBadges = screen.getAllByText('Required');
      expect(requiredBadges).toHaveLength(2);
    });

    it('renders input fields for each variable', () => {
      render(
        <VariableModal
          prompt={promptWithRequired}
          variables={['name', 'age']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      expect(screen.getByText('{{name}}')).toBeInTheDocument();
      expect(screen.getByText('{{age}}')).toBeInTheDocument();

      const textareas = screen.getAllByRole('textbox');
      expect(textareas).toHaveLength(2);
    });

    it('prevents submission when required fields are empty', () => {
      render(
        <VariableModal
          prompt={promptWithRequired}
          variables={['name', 'age']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      const applyButton = screen.getByRole('button', { name: /apply/i });
      fireEvent.click(applyButton);

      // Alert should be shown (mocked in test environment)
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe('Rendering with optional variables (defaults)', () => {
    const promptWithDefaults: Prompt = {
      id: 'test-2',
      name: 'Email Prompt',
      description: 'Email template',
      content:
        'Email {{recipient}} in {{language:English}} with {{tone:professional}} tone',
      model: mockModel,
      folderId: null,
    };

    it('shows optional badges for variables with defaults', () => {
      render(
        <VariableModal
          prompt={promptWithDefaults}
          variables={['recipient', 'language', 'tone']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      expect(screen.getByText('Required')).toBeInTheDocument();
      const optionalBadges = screen.getAllByText('Optional');
      expect(optionalBadges).toHaveLength(2);
    });

    it('displays default values in info boxes', () => {
      render(
        <VariableModal
          prompt={promptWithDefaults}
          variables={['recipient', 'language', 'tone']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      // Check for multiple default value indicators
      const defaultLabels = screen.getAllByText(/Default:/i);
      expect(defaultLabels.length).toBeGreaterThan(0);

      expect(screen.getByText('English')).toBeInTheDocument();
      expect(screen.getByText('professional')).toBeInTheDocument();
    });

    it('uses default values in placeholders', () => {
      render(
        <VariableModal
          prompt={promptWithDefaults}
          variables={['recipient', 'language', 'tone']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      const textareas = screen.getAllByRole('textbox');

      // Check that some textareas have default value placeholders
      const hasDefaultPlaceholder = Array.from(textareas).some(
        (textarea) =>
          textarea.getAttribute('placeholder')?.includes('English') ||
          textarea.getAttribute('placeholder')?.includes('professional'),
      );
      expect(hasDefaultPlaceholder).toBe(true);
    });
  });

  describe('Mixed required and optional variables', () => {
    const mixedPrompt: Prompt = {
      id: 'test-3',
      name: 'Donation Email',
      description: 'Thank you email for donations',
      content: `Dear {{donorName}},

Thank you for your donation of {{amount}} {{currency:$}}.

Language: {{language:English}}
Tone: {{tone:warm}}`,
      model: mockModel,
      folderId: null,
    };

    it('renders mix of required and optional badges correctly', () => {
      render(
        <VariableModal
          prompt={mixedPrompt}
          variables={['donorName', 'amount', 'currency', 'language', 'tone']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      const requiredBadges = screen.getAllByText('Required');
      expect(requiredBadges).toHaveLength(2); // donorName, amount

      const optionalBadges = screen.getAllByText('Optional');
      expect(optionalBadges).toHaveLength(3); // currency, language, tone
    });

    it('shows default values only for optional variables', () => {
      render(
        <VariableModal
          prompt={mixedPrompt}
          variables={['donorName', 'amount', 'currency', 'language', 'tone']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      // Should show defaults for currency, language, tone
      expect(screen.getByText('$')).toBeInTheDocument();
      expect(screen.getByText('English')).toBeInTheDocument();
      expect(screen.getByText('warm')).toBeInTheDocument();
    });
  });

  describe('User interactions', () => {
    const simplePrompt: Prompt = {
      id: 'test-4',
      name: 'Simple Test',
      description: 'Test',
      content: 'Hello {{name}}, language: {{lang:English}}',
      model: mockModel,
      folderId: null,
    };

    it('allows filling in required fields', () => {
      render(
        <VariableModal
          prompt={simplePrompt}
          variables={['name', 'lang']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      const textareas = screen.getAllByRole('textbox');
      const nameInput = textareas[0];

      fireEvent.change(nameInput, { target: { value: 'John Doe' } });

      expect(nameInput).toHaveValue('John Doe');
    });

    it('calls onSubmit with correct values when form is filled', async () => {
      // Mock window.alert for this test
      const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});

      render(
        <VariableModal
          prompt={simplePrompt}
          variables={['name', 'lang']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      const textareas = screen.getAllByRole('textbox');
      const nameInput = textareas[0];
      const langInput = textareas[1];

      // Fill in the required field
      fireEvent.change(nameInput, { target: { value: 'John Doe' } });

      // Leave optional field empty (should use default)
      fireEvent.change(langInput, { target: { value: '' } });

      const applyButton = screen.getByRole('button', { name: /apply/i });
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledWith(
          expect.arrayContaining(['John Doe', '']),
          expect.objectContaining({
            name: 'John Doe',
            lang: '',
          }),
        );
      });

      alertMock.mockRestore();
    });

    it('calls onClose when cancel button is clicked', () => {
      render(
        <VariableModal
          prompt={simplePrompt}
          variables={['name', 'lang']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      fireEvent.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('calls onClose when X button is clicked', () => {
      render(
        <VariableModal
          prompt={simplePrompt}
          variables={['name', 'lang']}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      const closeButton = screen.getByLabelText('Close');
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe('Complex scenario: Donation email template', () => {
    const donationTemplate: Prompt = {
      id: 'donation-1',
      name: 'Donation Thank You',
      description: 'Thank donors for their contributions',
      content: `Dear {{donorName}},

Thank you for your {{donationAmount}} {{currencySymbol:$}} donation on {{donationDate}}.

Type: {{giftType:one-time}}
Designation: {{designation:unrestricted}}
Region: {{region:global operations}}

Language: {{language:English}}
Include HTML: {{includeHTML:false}}`,
      model: mockModel,
      folderId: null,
    };

    it('renders all variables with correct required/optional status', () => {
      render(
        <VariableModal
          prompt={donationTemplate}
          variables={[
            'donorName',
            'donationAmount',
            'currencySymbol',
            'donationDate',
            'giftType',
            'designation',
            'region',
            'language',
            'includeHTML',
          ]}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      // Required: donorName, donationAmount, donationDate
      const requiredBadges = screen.getAllByText('Required');
      expect(requiredBadges).toHaveLength(3);

      // Optional: all others with defaults
      const optionalBadges = screen.getAllByText('Optional');
      expect(optionalBadges.length).toBeGreaterThan(0);
    });

    it('displays all default values', () => {
      render(
        <VariableModal
          prompt={donationTemplate}
          variables={[
            'donorName',
            'donationAmount',
            'currencySymbol',
            'donationDate',
            'giftType',
            'designation',
            'region',
            'language',
            'includeHTML',
          ]}
          onSubmit={mockOnSubmit}
          onClose={mockOnClose}
        />,
      );

      // Check for default values
      expect(screen.getByText('$')).toBeInTheDocument();
      expect(screen.getByText('one-time')).toBeInTheDocument();
      expect(screen.getByText('unrestricted')).toBeInTheDocument();
      expect(screen.getByText('global operations')).toBeInTheDocument();
      expect(screen.getByText('English')).toBeInTheDocument();
      expect(screen.getByText('false')).toBeInTheDocument();
    });
  });
});
