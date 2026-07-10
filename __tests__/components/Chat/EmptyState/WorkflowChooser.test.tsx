import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';

import { WorkflowChooser } from '@/components/Chat/EmptyState/WorkflowChooser';

import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockFlags: Record<string, unknown> = {};

vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const emptyConversation = {
  id: 'conv-1',
  name: '',
  messages: [],
  model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
  prompt: '',
  temperature: 0.5,
  folderId: null,
} as Conversation;

function setStore(conversation: Conversation | null) {
  useConversationStore.setState({
    conversations: conversation ? [conversation] : [],
    selectedConversationId: conversation?.id ?? null,
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

describe('WorkflowChooser', () => {
  beforeEach(() => {
    mockFlags = {};
    setStore(emptyConversation);
  });

  it('renders nothing when the flag is undefined (fail-closed)', () => {
    const { container } = render(<WorkflowChooser />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the flag is false', () => {
    mockFlags = { conversationWorkflows: false };
    const { container } = render(<WorkflowChooser />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the four workflow options when the flag is true', () => {
    mockFlags = { conversationWorkflows: true };
    render(<WorkflowChooser />);
    // Mock translations fall back to key names for the workflows namespace.
    expect(
      screen.getByRole('button', { name: /translation\.label/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('converts the selected empty conversation on click', () => {
    mockFlags = { conversationWorkflows: true };
    render(<WorkflowChooser />);

    fireEvent.click(screen.getByRole('button', { name: /translation\.label/ }));

    const stored = useConversationStore.getState().conversations[0];
    expect(stored.conversationType).toBe('translation');
    expect(stored.workflowState?.kind).toBe('translation');
  });

  it('renders nothing once the conversation has messages', () => {
    mockFlags = { conversationWorkflows: true };
    setStore({
      ...emptyConversation,
      messages: [
        { id: 'm1', role: 'user', content: 'hi' },
      ] as Conversation['messages'],
    });
    const { container } = render(<WorkflowChooser />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the conversation is already a workflow', () => {
    mockFlags = { conversationWorkflows: true };
    setStore({ ...emptyConversation, conversationType: 'map' });
    const { container } = render(<WorkflowChooser />);
    expect(container).toBeEmptyDOMElement();
  });
});
