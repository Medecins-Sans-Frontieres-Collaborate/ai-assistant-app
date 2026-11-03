import { act, fireEvent, render, screen } from '@testing-library/react';

import type { Conversation } from '@/types/chat';

import { SkillBadges } from '@/components/Chat/ChatInput/SkillBadges';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let skills: Array<Record<string, unknown>> = [];
vi.mock('@/client/hooks/settings/useUserSkills', () => ({
  useUserSkills: () => ({ data: skills, isPending: false }),
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

/**
 * Skills render as small icon bubbles in the composer's capability row:
 * an entry bubble that toggles the tray, one bubble per selection whose
 * hover label carries name and state, and an in-place remove.
 */
describe('SkillBadges bubbles', () => {
  beforeEach(() => {
    skills = ['gdpr', 'report'].map((id) => ({
      id,
      name: id,
      description: id,
      activation: 'auto',
      applyToAgents: false,
    }));
    useConversationStore.setState({
      conversations: [{ ...conversation }],
      selectedConversationId: 'one',
    });
    useChatInputStore.setState({
      forcedSkillIds: [],
      connectorPinTrayOpen: false,
    });
  });

  it('renders nothing when the user has no skills and nothing is selected', () => {
    skills = [];
    const { container } = render(<SkillBadges />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows one entry bubble that toggles the capabilities tray', () => {
    render(<SkillBadges />);
    const entry = screen.getByRole('button', { name: 'addSkill' });
    expect(entry).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(entry);
    expect(useChatInputStore.getState().connectorPinTrayOpen).toBe(true);
    expect(screen.getByRole('button', { name: 'addSkill' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // No selection → no skill bubbles, only the entry.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('renders each selection as a bubble whose label names the skill and its state', () => {
    act(() =>
      useConversationStore
        .getState()
        .updateConversation('one', { pinnedSkillIds: ['gdpr'] }),
    );
    act(() => useChatInputStore.getState().toggleForcedSkillId('report'));
    render(<SkillBadges />);
    expect(
      screen.getByRole('button', { name: 'gdpr (skillPinned)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'report (skillOnce)' }),
    ).toBeInTheDocument();
    // The × is a separate control, so the main bubble keeps a clean name.
    fireEvent.click(
      screen.getByRole('button', { name: 'removeSkill: report' }),
    );
    expect(useChatInputStore.getState().forcedSkillIds).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'removeSkill: gdpr' }));
    expect(
      useConversationStore.getState().conversations[0].pinnedSkillIds,
    ).toEqual([]);
  });

  it('keeps a stale pin visible as a muted bubble that can still be removed', () => {
    act(() =>
      useConversationStore
        .getState()
        .updateConversation('one', { pinnedSkillIds: ['deleted-skill'] }),
    );
    render(<SkillBadges />);
    expect(
      screen.getByRole('button', { name: 'deleted-skill (skillUnavailable)' }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'removeSkill: deleted-skill' }),
    );
    expect(
      useConversationStore.getState().conversations[0].pinnedSkillIds,
    ).toEqual([]);
  });
});
