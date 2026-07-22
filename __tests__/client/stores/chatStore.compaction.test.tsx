import { updateConversationCompaction } from '@/client/services/compactionService';

import { Conversation, Message, MessageType } from '@/types/chat';

import { chatService } from '@/client/services';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { useMemoryStore } from '@/client/stores/memoryStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `Message ${i}`,
    messageType: MessageType.TEXT,
  }));
}

function makeConversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: 'conv-1',
    name: 'test',
    messages: makeMessages(1),
    model: { id: 'gpt-5.2', name: 'GPT-5.2' } as never,
    prompt: '',
    temperature: 0.5,
    folderId: null,
    ...overrides,
  };
}

const compaction = {
  summary: 'earlier summary',
  upToEntryIndex: 5,
  updatedAt: '2026-07-01T00:00:00.000Z',
};

const memoryEntries = [
  {
    id: 'm1',
    text: 'Works at Contoso',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'm2',
    text: 'Prefers concise answers',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
];

describe('chatStore compaction + memories wiring', () => {
  let chatSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({
      contextWindowSize: 80,
      memoriesEnabled: false,
      memoriesFlagEnabled: false,
      mcpServers: [],
    });
    useMemoryStore.setState({ memories: [] });
    chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream());
  });

  const sentOptions = () => chatSpy.mock.calls[0][2] as Record<string, unknown>;
  const sentMessages = () => chatSpy.mock.calls[0][1] as Message[];

  describe('conversationSummary', () => {
    it('is attached when compaction exists and windowing drops messages', async () => {
      useSettingsStore.setState({ contextWindowSize: 20 });

      await useChatStore.getState().sendChatRequest(
        makeConversation({
          messages: makeMessages(30),
          compaction,
        }),
      );

      expect(sentOptions().conversationSummary).toBe('earlier summary');
      // 30 msgs @ 20: first + last 19, window start 11 is an assistant → 19
      expect(sentMessages()).toHaveLength(19);
    });

    it('is NOT attached when nothing is dropped, even with compaction stored', async () => {
      await useChatStore.getState().sendChatRequest(
        makeConversation({
          messages: makeMessages(5),
          compaction,
        }),
      );

      expect(sentOptions().conversationSummary).toBeUndefined();
    });

    it('is NOT attached when messages are dropped but no compaction exists yet', async () => {
      useSettingsStore.setState({ contextWindowSize: 20 });

      await useChatStore
        .getState()
        .sendChatRequest(makeConversation({ messages: makeMessages(30) }));

      expect(sentOptions().conversationSummary).toBeUndefined();
    });

    it('is NOT attached when the summary covers beyond the transcript (mid-conversation regenerate prefix)', async () => {
      useSettingsStore.setState({ contextWindowSize: 20 });

      // Regenerate prefix of a 250-message conversation: only 30 flat
      // messages are sent, but the stored summary covers entries 1..170.
      // Attaching it would leak the regenerated answer and later discussion.
      await useChatStore.getState().sendChatRequest(
        makeConversation({
          messages: makeMessages(30),
          compaction: { ...compaction, upToEntryIndex: 171 },
        }),
      );

      expect(sentOptions().conversationSummary).toBeUndefined();
    });

    it('is attached when upToEntryIndex exactly equals the transcript length', async () => {
      useSettingsStore.setState({ contextWindowSize: 20 });

      await useChatStore.getState().sendChatRequest(
        makeConversation({
          messages: makeMessages(30),
          compaction: { ...compaction, upToEntryIndex: 30 },
        }),
      );

      expect(sentOptions().conversationSummary).toBe('earlier summary');
    });
  });

  describe('memories', () => {
    it.each([
      { memoriesEnabled: false, memoriesFlagEnabled: false },
      { memoriesEnabled: true, memoriesFlagEnabled: false },
      { memoriesEnabled: false, memoriesFlagEnabled: true },
    ])(
      'are NOT attached unless BOTH gates are on (%o)',
      async ({ memoriesEnabled, memoriesFlagEnabled }) => {
        useSettingsStore.setState({ memoriesEnabled, memoriesFlagEnabled });
        useMemoryStore.setState({ memories: memoryEntries });

        await useChatStore.getState().sendChatRequest(makeConversation());

        expect(sentOptions().memories).toBeUndefined();
      },
    );

    it('are attached when user opt-in AND LD flag mirror are both on', async () => {
      useSettingsStore.setState({
        memoriesEnabled: true,
        memoriesFlagEnabled: true,
      });
      useMemoryStore.setState({ memories: memoryEntries });

      await useChatStore.getState().sendChatRequest(makeConversation());

      expect(sentOptions().memories).toEqual([
        'Works at Contoso',
        'Prefers concise answers',
      ]);
    });

    it('are NOT attached when both gates are on but the store is empty', async () => {
      useSettingsStore.setState({
        memoriesEnabled: true,
        memoriesFlagEnabled: true,
      });

      await useChatStore.getState().sendChatRequest(makeConversation());

      expect(sentOptions().memories).toBeUndefined();
    });

    it('selects the 60 most recently UPDATED when more than 60 are stored', async () => {
      useSettingsStore.setState({
        memoriesEnabled: true,
        memoriesFlagEnabled: true,
      });
      // 100 insertion-ordered memories; the entry at index 5 was updated in
      // place just now (newest updatedAt in the store). A naive tail slice
      // would drop it while keeping stale never-updated entries.
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      const manyMemories = Array.from({ length: 100 }, (_, i) => ({
        id: `mem-${i}`,
        text: `Memory ${i}`,
        createdAt: new Date(base + i * 1000).toISOString(),
        updatedAt: new Date(base + i * 1000).toISOString(),
      }));
      manyMemories[5] = {
        ...manyMemories[5],
        updatedAt: '2026-07-18T00:00:00.000Z',
      };
      useMemoryStore.setState({ memories: manyMemories });

      await useChatStore.getState().sendChatRequest(makeConversation());

      const sent = sentOptions().memories as string[];
      expect(sent).toHaveLength(60);
      expect(sent).toContain('Memory 5'); // freshly updated → included
      expect(sent).toContain('Memory 41'); // 41..99 fill the rest
      expect(sent).not.toContain('Memory 40'); // oldest-updated → dropped
    });

    it('truncates over-length memory text at the attach point (belt-and-suspenders)', async () => {
      useSettingsStore.setState({
        memoriesEnabled: true,
        memoriesFlagEnabled: true,
      });
      // Store writers normalize to 600 chars; a hand-edited/corrupted
      // localStorage entry must degrade instead of 400ing every chat send
      // on the server's per-memory cap.
      useMemoryStore.setState({
        memories: [
          {
            id: 'm-long',
            text: 'x'.repeat(700),
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });

      await useChatStore.getState().sendChatRequest(makeConversation());

      const sent = sentOptions().memories as string[];
      expect(sent).toHaveLength(1);
      expect(sent[0]).toHaveLength(600);
    });
  });

  describe('user-adjustable window size', () => {
    it('windows the sent messages with contextWindowSize instead of the default', async () => {
      const conversation = makeConversation({ messages: makeMessages(100) });

      // Default 80: first + last 79, orphaned assistant at start → 79
      await useChatStore.getState().sendChatRequest(conversation);
      expect(sentMessages()).toHaveLength(79);

      chatSpy.mockClear();
      useSettingsStore.setState({ contextWindowSize: 30 });

      // 30: first + last 29, window start 71 is an assistant → 29
      await useChatStore.getState().sendChatRequest(conversation);
      expect(sentMessages()).toHaveLength(29);
    });
  });

  describe('Foundry approval-resume', () => {
    it('never attaches summary or memories in the slice(-1) branch', async () => {
      useSettingsStore.setState({
        contextWindowSize: 20,
        memoriesEnabled: true,
        memoriesFlagEnabled: true,
      });
      useMemoryStore.setState({ memories: memoryEntries });

      const messages = makeMessages(26);
      // Trailing assistant carries a Foundry-style consent (no server_id)
      messages[25] = {
        ...messages[25],
        consentRequests: [
          {
            kind: 'approval',
            approval_request_id: 'foundry_1',
            tool_name: 'do_thing',
          },
        ],
      } as never;

      await useChatStore
        .getState()
        .sendChatRequest(
          makeConversation({ messages, compaction }),
          undefined,
          [{ approval_request_id: 'foundry_1', approve: true }],
        );

      expect(sentMessages()).toHaveLength(1);
      expect(sentOptions().conversationSummary).toBeUndefined();
      expect(sentOptions().memories).toBeUndefined();
    });
  });

  describe('updateConversationCompaction watermark advancement', () => {
    const summarizeBody = (fetchMock: ReturnType<typeof vi.fn>) =>
      JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ) as { messages: Message[] };

    const storedCompaction = () =>
      useConversationStore
        .getState()
        .conversations.find((c) => c.id === 'conv-1')?.compaction;

    it('summarizes the OLDEST uncovered messages and advances the watermark only over them', async () => {
      // 120 flat messages @ window 20 → boundary 102 (orphaned assistant at
      // 101). Uncovered gap 1..101 exceeds the 40-message cap: the oldest 40
      // must be summarized and the watermark must stop at 41, not jump to
      // 102 (which would skip messages 41..101 forever).
      const conversation = makeConversation({ messages: makeMessages(120) });
      useConversationStore.setState({ conversations: [conversation] });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ summary: 'fresh summary' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await updateConversationCompaction(
        conversation,
        conversation.messages as Message[],
        20,
      );

      const { messages } = summarizeBody(fetchMock);
      expect(messages).toHaveLength(40);
      expect(messages[0].content).toBe('Message 1'); // oldest first
      expect(messages[39].content).toBe('Message 40');
      expect(storedCompaction()).toMatchObject({
        summary: 'fresh summary',
        upToEntryIndex: 41, // 1 + 40 summarized, NOT boundary 102
      });

      vi.unstubAllGlobals();
    });

    it('advances the watermark to the boundary when the uncovered gap fits within the cap', async () => {
      // 30 flat messages @ window 20 → boundary 12; covered=5 → gap of 7.
      const conversation = makeConversation({
        messages: makeMessages(30),
        compaction: { ...compaction, upToEntryIndex: 5 },
      });
      useConversationStore.setState({ conversations: [conversation] });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ summary: 'fresh summary' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await updateConversationCompaction(
        conversation,
        conversation.messages as Message[],
        20,
      );

      const { messages } = summarizeBody(fetchMock);
      expect(messages).toHaveLength(7); // flat 5..11
      expect(messages[0].content).toBe('Message 5');
      expect(storedCompaction()).toMatchObject({ upToEntryIndex: 12 });

      vi.unstubAllGlobals();
    });
  });
});
