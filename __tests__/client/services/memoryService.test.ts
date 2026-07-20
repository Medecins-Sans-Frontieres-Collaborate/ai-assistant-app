import { extractMemories } from '@/client/services/memoryService';

import { Conversation, Message } from '@/types/chat';
import { MemoryOperation } from '@/types/memory';

import { useMemoryStore } from '@/client/stores/memoryStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: plain .ts on purpose — this file runs under BOTH vitest configs
// (node and jsdom include globs overlap on __tests__/client/**/*.test.ts),
// so it must stay environment-agnostic (no real Response/DOM usage).

// Mutable settings snapshot so tests can flip the gates mid-flight.
const mocks = vi.hoisted(() => ({
  settings: { memoriesEnabled: true, memoriesFlagEnabled: true },
}));

vi.mock('@/client/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => mocks.settings },
}));

const conversation = {
  id: 'conv-1',
  model: { id: 'gpt-5.2-chat' },
} as unknown as Conversation;

const flatMessages: Message[] = [
  { role: 'user', content: 'I live in Berlin', messageType: undefined },
  { role: 'assistant', content: 'Noted!', messageType: undefined },
];

const addBerlinOp: MemoryOperation[] = [
  { op: 'add', text: 'User lives in Berlin' },
];

/** fetch stub whose resolution the test controls, to simulate in-flight races. */
let resolveFetch: (value: unknown) => void;

const okResponse = (operations: MemoryOperation[]): unknown => ({
  ok: true,
  status: 200,
  json: async () => ({ operations }),
});

describe('extractMemories', () => {
  beforeEach(() => {
    useMemoryStore.setState({ memories: [] });
    mocks.settings.memoriesEnabled = true;
    mocks.settings.memoriesFlagEnabled = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies returned operations when the gates stay on', async () => {
    const pending = extractMemories(conversation, flatMessages);
    resolveFetch(okResponse(addBerlinOp));
    await pending;

    const memories = useMemoryStore.getState().memories;
    expect(memories.map((m) => m.text)).toEqual(['User lives in Berlin']);
    expect(memories[0].sourceConversationId).toBe('conv-1');
  });

  it('drops the result when the user opts out while the fetch is in flight', async () => {
    const pending = extractMemories(conversation, flatMessages);
    mocks.settings.memoriesEnabled = false;
    resolveFetch(okResponse(addBerlinOp));
    await pending;

    expect(useMemoryStore.getState().memories).toEqual([]);
  });

  it('drops the result when the feature flag flips off while in flight', async () => {
    const pending = extractMemories(conversation, flatMessages);
    mocks.settings.memoriesFlagEnabled = false;
    resolveFetch(okResponse(addBerlinOp));
    await pending;

    expect(useMemoryStore.getState().memories).toEqual([]);
  });

  it('drops the result when clearMemories ran while the fetch was in flight', async () => {
    useMemoryStore.getState().addMemory('pre-existing fact');

    const pending = extractMemories(conversation, flatMessages);
    // User clicks "Clear all memories" during the ~seconds-long round trip.
    useMemoryStore.getState().clearMemories();
    resolveFetch(okResponse(addBerlinOp));
    await pending;

    // Nothing resurrected: the cleared store stays empty.
    expect(useMemoryStore.getState().memories).toEqual([]);
  });

  it('still applies operations after an unrelated earlier clear', async () => {
    // A clear that completed BEFORE the fetch fired must not poison later
    // extractions — only a clear during the flight invalidates the result.
    useMemoryStore.getState().clearMemories();

    const pending = extractMemories(conversation, flatMessages);
    resolveFetch(okResponse(addBerlinOp));
    await pending;

    expect(useMemoryStore.getState().memories.map((m) => m.text)).toEqual([
      'User lives in Berlin',
    ]);
  });
});
