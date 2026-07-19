import { AssistantMessageGroup, Conversation, MessageType } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for the emissions pipeline: the usage metadata arriving in
 * the terminal stream block must be PERSISTED onto the assistant message
 * group (not just aggregated into settings stats) — the in-chat emissions
 * chip reads it from there.
 */
describe('ChatStore - usage persistence on assistant messages', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentMessage: undefined,
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      citations: [],
      error: null,
      stopRequested: false,
      loadingMessage: null,
    });
    useConversationStore.setState({ conversations: [] });
    global.fetch = vi.fn();
  });

  it('persists usage from the terminal metadata block onto the new message group', async () => {
    const conversation: Conversation = {
      id: 'new-chat',
      name: '',
      messages: [
        { role: 'user', content: 'Give me a recipe', messageType: 'TEXT' },
      ],
      model: OpenAIModels[OpenAIModelID.GPT_5_2],
      prompt: '',
      temperature: 0.7,
      folderId: null,
    };
    useConversationStore.setState({ conversations: [conversation] });

    const usagePayload = {
      usage: {
        promptTokens: 1200,
        completionTokens: 400,
        totalTokens: 1600,
        modelId: OpenAIModelID.GPT_5_2,
        region: null,
      },
    };
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('Here is a recipe...'));
        controller.enqueue(
          new TextEncoder().encode(
            `\n\n<<<METADATA_START>>>${JSON.stringify(usagePayload)}<<<METADATA_END>>>`,
          ),
        );
        controller.close();
      },
    });
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      body: mockStream,
    } as unknown as Response);

    await useChatStore.getState().sendMessage(
      {
        role: 'user',
        content: 'Give me a recipe',
        messageType: MessageType.TEXT,
      },
      conversation,
    );

    const stored = useConversationStore
      .getState()
      .conversations.find((c) => c.id === 'new-chat');
    expect(stored).toBeDefined();
    const group = stored!.messages.find(
      (entry): entry is AssistantMessageGroup =>
        (entry as AssistantMessageGroup).type === 'assistant_group',
    );
    expect(group).toBeDefined();
    expect(group!.versions[0].usage).toMatchObject({
      promptTokens: 1200,
      completionTokens: 400,
      modelId: OpenAIModelID.GPT_5_2,
    });
  });
});
