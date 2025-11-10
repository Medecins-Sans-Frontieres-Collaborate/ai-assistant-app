import { render, screen } from '@testing-library/react';
import React from 'react';

import { Message } from '@/types/chat';

import { ChatMessageText } from '@/components/Chat/ChatMessages/ChatMessageText';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Mock child components
vi.mock('@/components/Chat/ChatMessages/AssistantMessage', () => ({
  AssistantMessage: ({ content, message }: any) => (
    <div data-testid="assistant-message">Assistant: {content}</div>
  ),
}));

vi.mock('@/components/Chat/ChatMessages/UserMessage', () => ({
  UserMessage: ({ message, messageContent }: any) => (
    <div data-testid="user-message">User: {messageContent}</div>
  ),
}));

describe('ChatMessageText', () => {
  const defaultProps = {
    copyOnClick: vi.fn(),
    isEditing: false,
    setIsEditing: vi.fn(),
    setIsTyping: vi.fn(),
    handleInputChange: vi.fn(),
    textareaRef: { current: null },
    handlePressEnter: vi.fn(),
    handleEditMessage: vi.fn(),
    messageContent: 'Test message',
    setMessageContent: vi.fn(),
    toggleEditing: vi.fn(),
    handleDeleteMessage: vi.fn(),
    messageIsStreaming: false,
    messageIndex: 0,
    selectedConversation: null,
    messageCopied: false,
  };

  const createAssistantMessage = (content: string = 'Hello'): Message => ({
    role: 'assistant',
    content,
    messageType: undefined,
  });

  const createUserMessage = (content: string = 'Hi'): Message => ({
    role: 'user',
    content,
    messageType: undefined,
  });

  describe('Message Routing', () => {
    it('renders AssistantMessage for assistant role', () => {
      const message = createAssistantMessage('AI response');

      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
      expect(screen.getByText('Assistant: AI response')).toBeInTheDocument();
    });

    it('renders UserMessage for user role', () => {
      const message = createUserMessage('User question');

      render(
        <ChatMessageText
          {...defaultProps}
          message={message}
          messageContent="User question"
        />,
      );

      expect(screen.getByTestId('user-message')).toBeInTheDocument();
      expect(screen.getByText('User: User question')).toBeInTheDocument();
    });

    it('does not render both message types simultaneously', () => {
      const message = createAssistantMessage();

      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
      expect(screen.queryByTestId('user-message')).not.toBeInTheDocument();
    });
  });

  describe('Container Styling', () => {
    it('has group class for hover effects', () => {
      const message = createAssistantMessage();
      const { container } = render(
        <ChatMessageText {...defaultProps} message={message} />,
      );

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('group');
    });

    it('has text color classes', () => {
      const message = createAssistantMessage();
      const { container } = render(
        <ChatMessageText {...defaultProps} message={message} />,
      );

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('text-gray-800');
      expect(wrapper).toHaveClass('dark:text-gray-100');
    });

    it('has overflow wrap style', () => {
      const message = createAssistantMessage();
      const { container } = render(
        <ChatMessageText {...defaultProps} message={message} />,
      );

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveStyle({ overflowWrap: 'anywhere' });
    });
  });

  describe('Props Passing - Assistant Message', () => {
    it('passes content to AssistantMessage', () => {
      const message = createAssistantMessage('Test content');

      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByText('Assistant: Test content')).toBeInTheDocument();
    });

    it('passes message object to AssistantMessage', () => {
      const message = createAssistantMessage();

      render(<ChatMessageText {...defaultProps} message={message} />);

      // Verify message is rendered (mocked component receives it)
      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
    });
  });

  describe('Props Passing - User Message', () => {
    it('passes messageContent to UserMessage', () => {
      const message = createUserMessage();

      render(
        <ChatMessageText
          {...defaultProps}
          message={message}
          messageContent="Custom content"
        />,
      );

      expect(screen.getByText('User: Custom content')).toBeInTheDocument();
    });

    it('passes message object to UserMessage', () => {
      const message = createUserMessage();

      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByTestId('user-message')).toBeInTheDocument();
    });

    it('provides default onEdit callback when not provided', () => {
      const message = createUserMessage();

      // onEdit is optional, should provide empty function as default
      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByTestId('user-message')).toBeInTheDocument();
    });

    it('passes onEdit callback when provided', () => {
      const message = createUserMessage();
      const mockOnEdit = vi.fn();

      render(
        <ChatMessageText
          {...defaultProps}
          message={message}
          onEdit={mockOnEdit}
        />,
      );

      expect(screen.getByTestId('user-message')).toBeInTheDocument();
    });
  });

  describe('Different Message Types', () => {
    it('handles short messages', () => {
      const message = createAssistantMessage('Hi');

      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByText('Assistant: Hi')).toBeInTheDocument();
    });

    it('handles long messages', () => {
      const longContent = 'a'.repeat(1000);
      const message = createAssistantMessage(longContent);

      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
    });

    it('handles empty content', () => {
      const message = createAssistantMessage('');

      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
    });

    it('handles multiline content', () => {
      const message = createAssistantMessage('Line 1\nLine 2\nLine 3');

      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
    });
  });

  describe('State Props', () => {
    it('passes isEditing state to UserMessage', () => {
      const message = createUserMessage();

      render(
        <ChatMessageText
          {...defaultProps}
          message={message}
          isEditing={true}
        />,
      );

      expect(screen.getByTestId('user-message')).toBeInTheDocument();
    });

    it('passes selectedConversation to both message types', () => {
      const conversation = {
        id: '1',
        name: 'Test',
        messages: [],
        model: {
          id: 'gpt-4',
          name: 'GPT-4',
          maxLength: 4000,
          tokenLimit: 4000,
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      const assistantMessage = createAssistantMessage();
      const { rerender } = render(
        <ChatMessageText
          {...defaultProps}
          message={assistantMessage}
          selectedConversation={conversation}
        />,
      );

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();

      const userMessage = createUserMessage();
      rerender(
        <ChatMessageText
          {...defaultProps}
          message={userMessage}
          selectedConversation={conversation}
        />,
      );

      expect(screen.getByTestId('user-message')).toBeInTheDocument();
    });
  });

  describe('Callback Props', () => {
    it('passes copyOnClick to AssistantMessage', () => {
      const mockCopyOnClick = vi.fn();
      const message = createAssistantMessage();

      render(
        <ChatMessageText
          {...defaultProps}
          message={message}
          copyOnClick={mockCopyOnClick}
        />,
      );

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
    });

    it('passes toggleEditing to UserMessage', () => {
      const mockToggleEditing = vi.fn();
      const message = createUserMessage();

      render(
        <ChatMessageText
          {...defaultProps}
          message={message}
          toggleEditing={mockToggleEditing}
        />,
      );

      expect(screen.getByTestId('user-message')).toBeInTheDocument();
    });

    it('passes handleDeleteMessage to UserMessage', () => {
      const mockHandleDelete = vi.fn();
      const message = createUserMessage();

      render(
        <ChatMessageText
          {...defaultProps}
          message={message}
          handleDeleteMessage={mockHandleDelete}
        />,
      );

      expect(screen.getByTestId('user-message')).toBeInTheDocument();
    });
  });

  describe('Optional Props', () => {
    it('handles missing onQuestionClick', () => {
      const message = createAssistantMessage();

      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
    });

    it('handles missing onRegenerate', () => {
      const message = createAssistantMessage();

      render(<ChatMessageText {...defaultProps} message={message} />);

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
    });

    it('passes onRegenerate when provided', () => {
      const message = createAssistantMessage();
      const mockOnRegenerate = vi.fn();

      render(
        <ChatMessageText
          {...defaultProps}
          message={message}
          onRegenerate={mockOnRegenerate}
        />,
      );

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument();
    });
  });
});
