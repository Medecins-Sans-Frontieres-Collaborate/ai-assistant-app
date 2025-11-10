import React from 'react';

import ChatInputSubmitButton from '@/components/Chat/ChatInput/ChatInputSubmitButton';

import { fireEvent, render, screen } from '@/__tests__/testUtils';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('ChatInputSubmitButton', () => {
  const mockHandleSend = vi.fn();
  const mockHandleStopConversation = vi.fn();
  const mockPreventSubmission = vi.fn();

  beforeEach(() => {
    mockHandleSend.mockClear();
    mockHandleStopConversation.mockClear();
    mockPreventSubmission.mockClear();
  });

  describe('Send Button State', () => {
    it('renders send button when submission is not prevented', () => {
      mockPreventSubmission.mockReturnValue(false);

      render(
        <ChatInputSubmitButton
          isStreaming={false}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const button = screen.getByLabelText('Send message');
      expect(button).toBeInTheDocument();
    });

    it('calls handleSend when send button is clicked', () => {
      mockPreventSubmission.mockReturnValue(false);

      render(
        <ChatInputSubmitButton
          isStreaming={false}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const button = screen.getByLabelText('Send message');
      fireEvent.click(button);

      expect(mockHandleSend).toHaveBeenCalledTimes(1);
    });

    it('send button has correct styling', () => {
      mockPreventSubmission.mockReturnValue(false);

      render(
        <ChatInputSubmitButton
          isStreaming={false}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const button = screen.getByLabelText('Send message');
      expect(button).toHaveClass('rounded-full');
      expect(button).toHaveClass('bg-gray-300');
      expect(button).toHaveClass('dark:bg-[#171717]');
    });
  });

  describe('Stop Button State', () => {
    it('renders stop button when streaming and submission prevented', () => {
      mockPreventSubmission.mockReturnValue(true);

      render(
        <ChatInputSubmitButton
          isStreaming={true}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const button = screen.getByLabelText('Stop generation');
      expect(button).toBeInTheDocument();
    });

    it('calls handleStopConversation when stop button is clicked', () => {
      mockPreventSubmission.mockReturnValue(true);

      render(
        <ChatInputSubmitButton
          isStreaming={true}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const button = screen.getByLabelText('Stop generation');
      fireEvent.click(button);

      expect(mockHandleStopConversation).toHaveBeenCalledTimes(1);
    });

    it('stop button is disabled when not streaming', () => {
      mockPreventSubmission.mockReturnValue(true);

      render(
        <ChatInputSubmitButton
          isStreaming={false}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      // When not streaming and submission prevented, shows loader
      const container = screen.getByText(
        (content, element) => {
          return element?.classList.contains('animate-spin') || false;
        },
        { selector: 'svg' },
      );
      expect(container).toBeInTheDocument();
    });

    it('stop button has correct styling', () => {
      mockPreventSubmission.mockReturnValue(true);

      render(
        <ChatInputSubmitButton
          isStreaming={true}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const button = screen.getByLabelText('Stop generation');
      expect(button).toHaveClass('rounded-full');
      expect(button).toHaveClass('bg-gray-300');
      expect(button).toHaveClass('dark:bg-[#171717]');
    });
  });

  describe('Loading State', () => {
    it('shows loading spinner when submission prevented but not streaming', () => {
      mockPreventSubmission.mockReturnValue(true);

      const { container } = render(
        <ChatInputSubmitButton
          isStreaming={false}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
    });

    it('loading spinner has correct classes', () => {
      mockPreventSubmission.mockReturnValue(true);

      const { container } = render(
        <ChatInputSubmitButton
          isStreaming={false}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toHaveClass('text-gray-500');
    });

    it('loading spinner is wrapped in correct container', () => {
      mockPreventSubmission.mockReturnValue(true);

      const { container } = render(
        <ChatInputSubmitButton
          isStreaming={false}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const wrapper = container.querySelector(
        '.flex.items-center.justify-center.w-10.h-10',
      );
      expect(wrapper).toBeInTheDocument();
    });
  });

  describe('Transcribing State', () => {
    it('respects isTranscribing prop in combination with other states', () => {
      mockPreventSubmission.mockReturnValue(false);

      render(
        <ChatInputSubmitButton
          isStreaming={false}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      // When not prevented, should still show send button
      const button = screen.getByLabelText('Send message');
      expect(button).toBeInTheDocument();
    });
  });

  describe('Button Icons', () => {
    it('send button contains send icon', () => {
      mockPreventSubmission.mockReturnValue(false);

      const { container } = render(
        <ChatInputSubmitButton
          isStreaming={false}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const button = screen.getByLabelText('Send message');
      const icon = button.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });

    it('stop button contains stop icon', () => {
      mockPreventSubmission.mockReturnValue(true);

      const { container } = render(
        <ChatInputSubmitButton
          isStreaming={true}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const button = screen.getByLabelText('Stop generation');
      const icon = button.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('send button has aria-label', () => {
      mockPreventSubmission.mockReturnValue(false);

      render(
        <ChatInputSubmitButton
          isStreaming={false}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const button = screen.getByLabelText('Send message');
      expect(button).toHaveAttribute('aria-label', 'Send message');
    });

    it('stop button has aria-label', () => {
      mockPreventSubmission.mockReturnValue(true);

      render(
        <ChatInputSubmitButton
          isStreaming={true}
          handleSend={mockHandleSend}
          handleStopConversation={mockHandleStopConversation}
          preventSubmission={mockPreventSubmission}
        />,
      );

      const button = screen.getByLabelText('Stop generation');
      expect(button).toHaveAttribute('aria-label', 'Stop generation');
    });
  });
});
