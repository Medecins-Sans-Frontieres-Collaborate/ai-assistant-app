import { render, screen } from '@testing-library/react';

import type { Conversation } from '@/types/chat';

import { SkillControls } from '@/components/Chat/ChatInput/SkillControls';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/settings/useUserSkills', () => ({
  useUserSkills: () => ({
    data: [
      { id: 'gdpr', name: 'gdpr', description: 'gdpr', activation: 'auto' },
      {
        id: 'house-style',
        name: 'house-style',
        description: 'standing',
        activation: 'always',
        applyToAgents: true,
      },
    ],
    isPending: false,
  }),
}));

const conversation = {
  id: 'one',
  name: 'Test',
  messages: [],
  model: { id: 'gpt-5.2', name: 'GPT' },
  prompt: '',
  temperature: 1,
  folderId: null,
} as Conversation;

describe('SkillControls — standing skills', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: [{ ...conversation }],
      selectedConversationId: 'one',
    });
    useChatInputStore.setState({ forcedSkillIds: [] });
  });

  it('lists always-on skills as standing instead of offering use-once/pin', () => {
    render(<SkillControls />);
    expect(screen.getByText('house-style')).toBeInTheDocument();
    expect(screen.getByText('skillAlwaysOn')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /skillPin.*house-style/ }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /skillPin.*gdpr/ }),
    ).toBeInTheDocument();
  });

  it('offers always-on skills like any other when an agent is attached (agents only get skills as tools)', () => {
    useConversationStore.setState({
      conversations: [
        {
          ...conversation,
          model: {
            id: 'gpt-5.2',
            name: 'GPT',
            agentId: 'asst_1',
            supportsTools: true,
          },
        } as Conversation,
      ],
      selectedConversationId: 'one',
    });
    render(<SkillControls />);
    expect(screen.queryByText('skillAlwaysOn')).toBeNull();
    expect(
      screen.getByRole('button', { name: /skillPin.*house-style/ }),
    ).toBeInTheDocument();
  });
});
