import { Conversation, MessageType } from '@/types/chat';

import { chatService } from '@/client/services';
import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const conversation: Conversation = {
  id: 'skill-replay',
  name: 'Test',
  model: { id: 'gpt-5.2', name: 'GPT' } as never,
  prompt: '',
  temperature: 1,
  folderId: null,
  messages: [
    {
      id: 'question',
      role: 'user',
      messageType: MessageType.TEXT,
      content: 'Review my notes',
    },
  ],
};
describe('one-shot skill replay', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({
      mcpServers: [],
      memoriesEnabled: false,
      contextWindowSize: 80,
    });
    useChatInputStore.setState({ forcedSkillIds: [] });
    useConversationStore.setState({
      conversations: [{ ...conversation }],
      selectedConversationId: conversation.id,
    });
    vi.spyOn(chatService, 'chat').mockResolvedValue(new ReadableStream());
  });
  it('keeps the original one-shot choice for retry/regeneration but not for a new question', async () => {
    useChatInputStore.setState({ forcedSkillIds: ['gdpr'] });
    await useChatStore.getState().sendChatRequest(conversation);
    expect(useChatInputStore.getState().forcedSkillIds).toEqual([]);
    const persisted =
      useConversationStore.getState().conversations[0].messages[0];
    expect(persisted).toHaveProperty('requestedSkillIds', ['gdpr']);
    await useChatStore.getState().sendChatRequest(conversation); // deliberately stale snapshot
    const calls = vi.mocked(chatService.chat).mock.calls;
    expect(calls[1][2]?.forcedSkillIds).toEqual(['gdpr']);
    await useChatStore.getState().sendChatRequest({
      ...conversation,
      messages: [
        ...conversation.messages,
        {
          id: 'new-question',
          role: 'user',
          messageType: MessageType.TEXT,
          content: 'Different question',
        },
      ],
    });
    expect(
      vi.mocked(chatService.chat).mock.calls[2][2]?.forcedSkillIds,
    ).toBeUndefined();
  });
  it('finalization from the original snapshot does not erase saved choices', async () => {
    useChatInputStore.setState({ forcedSkillIds: ['gdpr'] });
    await useChatStore.getState().sendChatRequest(conversation);
    await useChatStore
      .getState()
      .finalizeMessage(
        { role: 'assistant', content: 'Answer', messageType: MessageType.TEXT },
        conversation,
      );
    expect(
      useConversationStore.getState().conversations[0].messages[0],
    ).toHaveProperty('requestedSkillIds', ['gdpr']);
  });
});
