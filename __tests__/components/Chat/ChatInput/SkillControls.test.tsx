import { act, fireEvent, render, screen } from '@testing-library/react';

import type { Conversation } from '@/types/chat';

import { SkillBadges } from '@/components/Chat/ChatInput/SkillBadges';
import { SkillControls } from '@/components/Chat/ChatInput/SkillControls';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/settings/useUserSkills', () => ({
  useUserSkills: () => ({
    data: ['gdpr', 'report', 'forms', 'platform-help'].map((id) => ({
      id,
      name: id,
      description: id,
      activation: 'auto',
      applyToAgents: id === 'gdpr',
    })),
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
describe('skill controls on real conversation state', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: [{ ...conversation }, { ...conversation, id: 'two' }],
      selectedConversationId: 'one',
    });
    useChatInputStore.setState({ forcedSkillIds: [] });
  });

  it('pins persist after one-shot state resets and do not leak to another conversation', () => {
    render(
      <>
        <SkillControls />
        <SkillBadges />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /skillPin.*gdpr/ }));
    expect(
      useConversationStore.getState().conversations[0].pinnedSkillIds,
    ).toEqual(['gdpr']);
    act(() => useChatInputStore.getState().resetForNewConversation());
    expect(
      screen.getByRole('button', { name: /skillPin.*gdpr/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    act(() => useConversationStore.getState().selectConversation('two'));
    expect(
      screen.getByRole('button', { name: /skillPin.*gdpr/ }),
    ).toHaveAttribute('aria-pressed', 'false');
    act(() => useConversationStore.getState().selectConversation('one'));
    expect(
      screen.getByRole('button', { name: /skillPin.*gdpr/ }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves a one-shot choice into a pin and removing the chip actually unpins', () => {
    render(
      <>
        <SkillControls />
        <SkillBadges />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /skillUseOnce.*gdpr/ }));
    expect(useChatInputStore.getState().forcedSkillIds).toEqual(['gdpr']);
    fireEvent.click(screen.getByRole('button', { name: /skillPin.*gdpr/ }));
    expect(useChatInputStore.getState().forcedSkillIds).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /removeSkill.*gdpr/ }));
    expect(
      useConversationStore.getState().conversations[0].pinnedSkillIds,
    ).toEqual([]);
  });

  it('enforces a combined three-selection limit', () => {
    render(<SkillControls />);
    fireEvent.click(screen.getByRole('button', { name: /skillPin.*gdpr/ }));
    fireEvent.click(
      screen.getByRole('button', { name: /skillUseOnce.*report/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: /skillPin.*forms/ }));
    expect(
      screen.getByRole('button', { name: /skillPin.*platform-help/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /skillUseOnce.*platform-help/ }),
    ).toBeDisabled();
  });

  it('pauses for an agent while leaving existing pins removable', () => {
    act(() =>
      useConversationStore.getState().updateConversation('one', {
        bot: 'agent',
        pinnedSkillIds: ['report'],
      }),
    );
    render(
      <>
        <SkillControls />
        <SkillBadges />
      </>,
    );
    expect(
      screen.queryByRole('button', { name: /skillPin.*report/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /skillPin.*gdpr/ }),
    ).not.toBeDisabled();
    expect(screen.getByText(/skillsAgentToolsHint/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /removeSkill.*report/ }),
    );
    expect(
      useConversationStore.getState().conversations[0].pinnedSkillIds,
    ).toEqual([]);
  });

  it('keeps deleted or revoked pins visible and removable', () => {
    act(() =>
      useConversationStore
        .getState()
        .updateConversation('one', { pinnedSkillIds: ['deleted-skill'] }),
    );
    render(<SkillBadges />);
    expect(screen.getByText(/skillUnavailable/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /removeSkill.*deleted-skill/ }),
    );
    expect(
      useConversationStore.getState().conversations[0].pinnedSkillIds,
    ).toEqual([]);
  });
});
