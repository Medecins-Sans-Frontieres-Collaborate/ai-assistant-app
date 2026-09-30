import { act, render, screen } from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';

import { WorkflowShell } from '@/components/Workflows/WorkflowShell';
import { createInitialWorkflowState } from '@/components/Workflows/initialState';

import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/workflows/useWorkflowPolicy', () => ({
  useWorkflowPolicy: () => ({
    isWorkflowEnabled: () => true,
    isLoading: false,
  }),
}));

vi.mock('@/client/hooks/ui/useUI', () => ({
  useUI: () => ({ toggleChatbar: vi.fn() }),
}));

/** Mount count of the test workspace: the thing the key is for. */
const mounts = vi.hoisted(() => ({ count: 0 }));

// A registry with one workspace that counts its mounts, in place of the
// lazy real ones: what is tested is the shell's keying, not a workspace.
vi.mock('@/components/Workflows/registry', async () => {
  const ReactModule = await import('react');
  const Workspace = ({ conversationId }: { conversationId: string }) => {
    ReactModule.useEffect(() => {
      mounts.count += 1;
    }, []);
    return ReactModule.createElement(
      'div',
      { 'data-testid': 'workspace' },
      conversationId,
    );
  };
  return {
    WORKFLOW_REGISTRY: {
      translation: {
        meta: { icon: () => null, i18nKey: 'translation' },
        Workspace,
        createInitialState: () => ({}),
      },
    },
  };
});

function conversation(id: string): Conversation {
  return {
    id,
    name: `Draft ${id}`,
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
    prompt: '',
    temperature: 0.5,
    folderId: null,
    conversationType: 'translation',
    workflowState: createInitialWorkflowState('translation'),
  } as Conversation;
}

describe('WorkflowShell keys the workspace per conversation', () => {
  beforeEach(() => {
    mounts.count = 0;
    useConversationStore.setState({
      conversations: [conversation('wf-a'), conversation('wf-b')],
      selectedConversationId: 'wf-a',
      folders: [],
      searchTerm: '',
      isLoaded: true,
    });
  });

  /**
   * Two drafts of the same kind used to share one workspace instance, so
   * once-per-mount work (the drafter's seed) never ran for the second one
   * and transient state leaked across. The key forces a fresh instance.
   */
  // The shell renders the workspace pane twice (a desktop and a mobile
  // container, one hidden by CSS), so every mount counts double here.
  it('remounts the workspace when the user switches to another conversation of the same kind', () => {
    render(<WorkflowShell />);
    for (const pane of screen.getAllByTestId('workspace')) {
      expect(pane).toHaveTextContent('wf-a');
    }
    expect(mounts.count).toBe(2);

    act(() => {
      useConversationStore.setState({ selectedConversationId: 'wf-b' });
    });
    for (const pane of screen.getAllByTestId('workspace')) {
      expect(pane).toHaveTextContent('wf-b');
    }
    expect(mounts.count).toBe(4);
  });

  it('does not remount while the same conversation stays selected', () => {
    render(<WorkflowShell />);
    act(() => {
      useConversationStore.setState({ searchTerm: 'x' });
    });
    expect(mounts.count).toBe(2);
  });
});
