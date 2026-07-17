import {
  SYSTEM_PROMPT_TOKEN_ALLOWANCE,
  conversationUsesAgent,
  estimateConversationUsage,
  estimateUntrackedRequests,
} from '@/lib/utils/shared/chat/usageBackfill';

import { AssistantMessageGroup, Conversation, Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { describe, expect, it } from 'vitest';

// 4 chars = 1 token (CHARS_PER_TOKEN) — build content by token count.
const text = (tokens: number) => 'a'.repeat(tokens * 4);

const user = (tokens: number): Message => ({
  role: 'user',
  content: text(tokens),
  messageType: 'TEXT',
});

const assistantFlat = (tokens: number, extra?: Partial<Message>): Message => ({
  role: 'assistant',
  content: text(tokens),
  messageType: 'TEXT',
  ...extra,
});

const group = (
  versions: Array<{
    tokens: number;
    createdAt?: string;
    usage?: boolean;
    error?: boolean;
  }>,
  activeIndex = versions.length - 1,
): AssistantMessageGroup => ({
  type: 'assistant_group',
  activeIndex,
  versions: versions.map((v) => ({
    content: text(v.tokens),
    messageType: 'TEXT',
    createdAt: v.createdAt ?? '2026-01-01T00:00:00.000Z',
    ...(v.usage
      ? {
          usage: {
            promptTokens: 10,
            completionTokens: 10,
            totalTokens: 20,
            modelId: 'gpt-test',
            region: null,
          },
        }
      : {}),
    ...(v.error ? { error: true } : {}),
  })),
});

const conversation = (
  messages: Conversation['messages'],
  extra?: Partial<Conversation>,
): Conversation => ({
  id: 'c1',
  name: 'test',
  messages,
  model: { id: 'gpt-test', name: 'GPT Test' } as OpenAIModel,
  prompt: '',
  temperature: 0.5,
  folderId: null,
  ...extra,
});

describe('estimateUntrackedRequests', () => {
  it('models cumulative prompt context across turns', () => {
    const conv = conversation([
      user(100),
      assistantFlat(50),
      user(30),
      assistantFlat(20),
    ]);
    const requests = estimateUntrackedRequests(conv);
    expect(requests).toHaveLength(2);
    // First request: system allowance + user1.
    expect(requests[0]).toMatchObject({
      entryIndex: 1,
      versionIndex: null,
      promptTokens: SYSTEM_PROMPT_TOKEN_ALLOWANCE + 100,
      completionTokens: 50,
    });
    // Second request resends everything prior: allowance + user1 + assistant1 + user2.
    expect(requests[1]).toMatchObject({
      entryIndex: 3,
      promptTokens: SYSTEM_PROMPT_TOKEN_ALLOWANCE + 100 + 50 + 30,
      completionTokens: 20,
    });
  });

  it('includes the conversation prompt in the context', () => {
    const conv = conversation([user(10), assistantFlat(5)], {
      prompt: text(40),
    });
    const [request] = estimateUntrackedRequests(conv);
    expect(request.promptTokens).toBe(SYSTEM_PROMPT_TOKEN_ALLOWANCE + 40 + 10);
  });

  it('counts every group version as one request, carrying only the active version forward', () => {
    const conv = conversation([
      user(100),
      group([{ tokens: 50 }, { tokens: 80 }], 1),
      user(10),
      assistantFlat(5),
    ]);
    const requests = estimateUntrackedRequests(conv);
    expect(requests).toHaveLength(3);
    // Both versions saw the same prior context.
    expect(requests[0].promptTokens).toBe(SYSTEM_PROMPT_TOKEN_ALLOWANCE + 100);
    expect(requests[1].promptTokens).toBe(SYSTEM_PROMPT_TOKEN_ALLOWANCE + 100);
    expect(requests[0].versionIndex).toBe(0);
    expect(requests[1].versionIndex).toBe(1);
    // Later context includes ONLY the active version (80), not both.
    expect(requests[2].promptTokens).toBe(
      SYSTEM_PROMPT_TOKEN_ALLOWANCE + 100 + 80 + 10,
    );
  });

  it('skips versions that already carry persisted usage', () => {
    const conv = conversation([
      user(10),
      group([{ tokens: 50, usage: true }, { tokens: 80 }]),
    ]);
    const requests = estimateUntrackedRequests(conv);
    expect(requests).toHaveLength(1);
    expect(requests[0].versionIndex).toBe(1);
  });

  it('skips error and empty turns', () => {
    const conv = conversation([
      user(10),
      group([{ tokens: 50, error: true }, { tokens: 0 }]),
    ]);
    expect(estimateUntrackedRequests(conv)).toHaveLength(0);
  });

  it('applies the cutoff to version timestamps', () => {
    const cutoff = '2026-06-01T00:00:00.000Z';
    const conv = conversation([
      user(10),
      group([
        { tokens: 50, createdAt: '2026-05-01T00:00:00.000Z' },
        { tokens: 80, createdAt: '2026-07-01T00:00:00.000Z' },
      ]),
    ]);
    const requests = estimateUntrackedRequests(conv, {
      onlyBeforeIso: cutoff,
    });
    // Post-cutoff version was live-tracked (then discarded) — never double count.
    expect(requests).toHaveLength(1);
    expect(requests[0].versionIndex).toBe(0);
  });

  it('falls back to the conversation timestamp for flat legacy messages', () => {
    const cutoff = '2026-06-01T00:00:00.000Z';
    const oldConv = conversation([user(10), assistantFlat(5)], {
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    const newConv = conversation([user(10), assistantFlat(5)], {
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(
      estimateUntrackedRequests(oldConv, { onlyBeforeIso: cutoff }),
    ).toHaveLength(1);
    // Conservative: touched after tracking began → skipped, never double counted.
    expect(
      estimateUntrackedRequests(newConv, { onlyBeforeIso: cutoff }),
    ).toHaveLength(0);
  });

  it('includes everything untracked when there is no cutoff', () => {
    const conv = conversation([user(10), assistantFlat(5)], {
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(estimateUntrackedRequests(conv)).toHaveLength(1);
  });

  it('returns [] for empty conversations', () => {
    expect(estimateUntrackedRequests(conversation([]))).toHaveLength(0);
  });

  it('windows very long conversations like the real pipeline (first + last 79 messages)', () => {
    // 100 user/assistant pairs of 10 tokens each — well past the 80-message
    // window. Without windowing the last request's prompt would be ~2000
    // tokens of history; with it, only first + last 79 messages count.
    const messages: Conversation['messages'] = [];
    for (let i = 0; i < 100; i++) {
      messages.push(user(10), assistantFlat(10));
    }
    const conv = conversation(messages);
    const requests = estimateUntrackedRequests(conv);
    expect(requests).toHaveLength(100);

    const last = requests[requests.length - 1];
    // At the last request 199 messages were sent; windowed = first (10) +
    // last 79 (790) = 800, plus the system allowance.
    expect(last.promptTokens).toBe(SYSTEM_PROMPT_TOKEN_ALLOWANCE + 10 + 790);

    // Growth is bounded: every request's prompt stays at or below the window,
    // instead of growing linearly with history.
    const maxPrompt = Math.max(...requests.map((r) => r.promptTokens));
    expect(maxPrompt).toBeLessThanOrEqual(
      SYSTEM_PROMPT_TOKEN_ALLOWANCE + 10 + 790,
    );
  });

  it('caps the prompt at the model context window (maxLength tokens)', () => {
    const conv = conversation([user(5000), assistantFlat(10)], {
      model: {
        id: 'tiny',
        name: 'Tiny',
        maxLength: 1000,
      } as OpenAIModel,
    });
    const [request] = estimateUntrackedRequests(conv);
    expect(request.promptTokens).toBe(1000);
  });
});

describe('estimateConversationUsage', () => {
  it('sums per-request estimates into one bucket', () => {
    const conv = conversation([
      user(100),
      assistantFlat(50),
      user(30),
      assistantFlat(20),
    ]);
    const bucket = estimateConversationUsage(conv);
    expect(bucket.requests).toBe(2);
    expect(bucket.completionTokens).toBe(70);
    expect(bucket.promptTokens).toBe(
      SYSTEM_PROMPT_TOKEN_ALLOWANCE +
        100 +
        (SYSTEM_PROMPT_TOKEN_ALLOWANCE + 100 + 50 + 30),
    );
  });

  it('returns an empty bucket for conversations with nothing untracked', () => {
    expect(estimateConversationUsage(conversation([user(10)]))).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      requests: 0,
    });
  });
});

describe('conversationUsesAgent / isAgentModel', () => {
  it('detects real agent conversations', () => {
    expect(
      conversationUsesAgent(
        conversation([], {
          model: { id: 'a', name: 'A', modelType: 'agent' } as OpenAIModel,
        }),
      ),
    ).toBe(true);
    expect(
      conversationUsesAgent(
        conversation([], {
          model: {
            id: 'a',
            name: 'A',
            isOrganizationAgent: true,
          } as OpenAIModel,
        }),
      ),
    ).toBe(true);
    expect(
      conversationUsesAgent(
        conversation([], {
          model: { id: 'org-comms', name: 'Comms' } as OpenAIModel,
        }),
      ),
    ).toBe(true);
    expect(
      conversationUsesAgent(
        conversation([], {
          model: { id: 'foundry-x-agent', name: 'X' } as OpenAIModel,
        }),
      ),
    ).toBe(true);
    expect(conversationUsesAgent(conversation([], { bot: 'comms' }))).toBe(
      true,
    );
    expect(conversationUsesAgent(conversation([]))).toBe(false);
  });

  it('does NOT treat isAgent:true base models as agents (regression)', () => {
    // On base models (gpt-5.2, claude-*), isAgent only marks that a
    // web-search Foundry agent is AVAILABLE — standard chats are tracked.
    expect(
      conversationUsesAgent(
        conversation([], {
          model: {
            id: 'gpt-5.2-chat',
            name: 'GPT-5.2 Chat',
            isAgent: true,
            modelType: 'omni',
          } as OpenAIModel,
        }),
      ),
    ).toBe(false);
  });
});
