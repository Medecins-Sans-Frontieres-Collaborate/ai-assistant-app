import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { Message } from '@/types/chat';

import { UserMessage } from '@/components/Chat/ChatMessages/UserMessage';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// The markdown renderer is stood in for by a marker element, so a test can
// tell "went through markdown" from "printed as a plain string".
vi.mock('@/components/Markdown/MathStreamdown', () => ({
  MathStreamdown: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => ({ prompts: [] }),
}));

vi.mock('@/client/hooks/settings/useTones', () => ({
  useTones: () => ({ tones: [] }),
}));

vi.mock('@/client/stores/artifactStore', () => ({
  useArtifactStore: () => ({ openArtifact: vi.fn(), openDocument: vi.fn() }),
}));

const PROMPT = 'First paragraph.\n\n- one\n- **two**';
const FILE = {
  type: 'file_url',
  url: '/api/file/notes.txt',
  originalFilename: 'notes.txt',
};

const userMessage = (content: Message['content']): Message => ({
  role: 'user',
  content,
  messageType: undefined,
});

const renderMessage = (
  message: Message,
  overrides: Partial<React.ComponentProps<typeof UserMessage>> = {},
  children?: React.ReactNode,
) => {
  const props: React.ComponentProps<typeof UserMessage> = {
    message,
    messageContent: '',
    setMessageContent: vi.fn(),
    isEditing: false,
    textareaRef: { current: null },
    handleInputChange: vi.fn(),
    handlePressEnter: vi.fn(),
    setIsTyping: vi.fn(),
    setIsEditing: vi.fn(),
    toggleEditing: vi.fn(),
    handleDeleteMessage: vi.fn(),
    onEdit: vi.fn(),
    selectedConversation: { id: 'c1', messages: [] } as never,
    ...overrides,
  };
  render(<UserMessage {...props}>{children}</UserMessage>);
  return props;
};

describe('UserMessage text rendering', () => {
  it('renders a plain message through markdown', () => {
    renderMessage(userMessage(PROMPT));

    expect(screen.getByTestId('markdown').textContent).toBe(PROMPT);
  });

  it('renders the text of a message with an upload through the same markdown path', () => {
    renderMessage(
      userMessage([FILE, { type: 'text', text: PROMPT }] as Message['content']),
      {},
      <div data-testid="attachment">notes.txt</div>,
    );

    expect(screen.getByTestId('attachment')).toBeInTheDocument();
    // Line breaks and markdown source reach the renderer intact, once.
    expect(screen.getAllByTestId('markdown')).toHaveLength(1);
    expect(screen.getByTestId('markdown').textContent).toBe(PROMPT);
  });

  it('renders no text block for an upload with no caption', () => {
    renderMessage(
      userMessage([FILE] as Message['content']),
      {},
      <div data-testid="attachment">notes.txt</div>,
    );

    expect(screen.getByTestId('attachment')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument();
  });
});

describe('UserMessage editing', () => {
  it('offers the typed text for editing when the message has an upload', () => {
    renderMessage(
      userMessage([FILE, { type: 'text', text: PROMPT }] as Message['content']),
      { isEditing: true },
    );

    expect(screen.getByRole('textbox')).toHaveValue(PROMPT);
  });

  it('keeps the upload when the caption is edited and saved', () => {
    const props = renderMessage(
      userMessage([FILE, { type: 'text', text: 'old' }] as Message['content']),
      { isEditing: true },
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'new caption' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Submit' }));

    expect(props.onEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [FILE, { type: 'text', text: 'new caption' }],
      }),
    );
  });

  it('saves a plain message as a plain string', () => {
    const props = renderMessage(userMessage('old'), { isEditing: true });

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Submit' }));

    expect(props.onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'new' }),
    );
  });

  it('does not submit when nothing changed', () => {
    const props = renderMessage(
      userMessage([FILE, { type: 'text', text: 'same' }] as Message['content']),
      { isEditing: true },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save & Submit' }));

    expect(props.onEdit).not.toHaveBeenCalled();
  });
});
