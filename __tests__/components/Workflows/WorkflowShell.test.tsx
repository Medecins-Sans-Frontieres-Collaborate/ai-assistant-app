import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';
import { ConversationWorkflowType } from '@/types/workflow';

import { WorkflowShell } from '@/components/Workflows/WorkflowShell';
import { createInitialWorkflowState } from '@/components/Workflows/initialState';

import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/ui/useUI', () => ({
  useUI: () => ({ toggleChatbar: vi.fn() }),
}));

function setWorkflowConversation(type: ConversationWorkflowType) {
  const conversation = {
    id: 'wf-1',
    name: 'My workflow',
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
    prompt: '',
    temperature: 0.5,
    folderId: null,
    conversationType: type,
    workflowState: createInitialWorkflowState(type),
  } as Conversation;
  useConversationStore.setState({
    conversations: [conversation],
    selectedConversationId: conversation.id,
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

describe('WorkflowShell', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      folders: [],
      searchTerm: '',
      isLoaded: true,
    });
  });

  it('renders nothing without a selected workflow conversation', () => {
    const { container } = render(<WorkflowShell />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([['translation'], ['document'], ['data-analysis'], ['map']] as const)(
    'renders the badge and workspace slot for %s',
    (type) => {
      setWorkflowConversation(type);
      render(<WorkflowShell />);

      expect(screen.getByText('My workflow')).toBeInTheDocument();
      // The desktop rail is open by default with its composer present.
      expect(
        screen.getByRole('button', { name: /hideConversation|shell\.hide/ }),
      ).toBeInTheDocument();
    },
  );

  it('toggles the conversation rail with aria-pressed', () => {
    setWorkflowConversation('translation');
    render(<WorkflowShell />);

    const toggle = screen.getByRole('button', {
      name: /hideConversation|shell\.hide/,
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(toggle);
    const collapsed = screen.getByRole('button', {
      name: /showConversation|shell\.show/,
    });
    expect(collapsed).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders even though the LaunchDarkly flag is absent (existing conversations must open)', () => {
    // No useFlags mock configured here on purpose: the shell must not
    // consult the flag at all.
    setWorkflowConversation('map');
    render(<WorkflowShell />);
    expect(screen.getByText('My workflow')).toBeInTheDocument();
  });
});
