import { Session } from 'next-auth';

import { AIFoundryAgentHandler } from '@/lib/services/chat/AIFoundryAgentHandler';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock fns so they can be referenced inside vi.mock factories.
const mockThreadsCreate = vi.hoisted(() => vi.fn());
const mockThreadsDelete = vi.hoisted(() => vi.fn());
const mockMessagesCreate = vi.hoisted(() => vi.fn());
const mockRunsCreate = vi.hoisted(() => vi.fn());
const mockAgentsClient = vi.hoisted(() => vi.fn());
const mockDefaultAzureCredential = vi.hoisted(() => vi.fn());

vi.mock('@azure/ai-agents', () => ({
  AgentsClient: mockAgentsClient,
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: mockDefaultAzureCredential,
}));

vi.mock('@/config/environment', () => ({
  env: {
    AZURE_AI_FOUNDRY_ENDPOINT: 'https://test-foundry.services.ai.azure.com',
  },
}));

vi.mock('@/lib/utils/server/chat/chat', () => ({
  getMessagesToSend: vi.fn((msgs: Message[]) => Promise.resolve(msgs)),
}));

vi.mock('@/lib/utils/server/tiktoken/tiktokenCache', () => ({
  getGlobalTiktoken: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@/lib/services/chat/observability/MetricsService', () => ({
  MetricsService: {
    recordRequest: vi.fn(),
    recordError: vi.fn(),
    recordTokenUsage: vi.fn(),
  },
}));

/**
 * Build an async-iterable run stream that yields the given events sequentially.
 * Matches the shape AIFoundryAgentHandler expects: `eventMessage.event` + `.data`.
 */
function makeRunStream(events: Array<{ event: string; data?: any }>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) {
        yield ev;
      }
    },
  };
}

function deltaEvent(text: string) {
  return {
    event: 'thread.message.delta',
    data: { delta: { content: [{ type: 'text', text: { value: text } }] } },
  };
}

const completedEvent = { event: 'thread.message.completed', data: {} };
const runCompletedEvent = { event: 'thread.run.completed', data: {} };
const doneEvent = { event: 'done', data: {} };

const testUser: Session['user'] = {
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
} as unknown as Session['user'];

const testModel: OpenAIModel = {
  id: 'agent-test',
  name: 'Test Agent',
  maxLength: 16000,
  tokenLimit: 8000,
  agentId: 'asst_test_agent',
} as OpenAIModel;

const testMessages: Message[] = [
  { role: 'user', content: 'hello', messageType: undefined } as Message,
];

async function drainStream(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AIFoundryAgentHandler — ephemeral thread cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaultAzureCredential.mockImplementation(function (this: any) {
      return {};
    });
    mockAgentsClient.mockImplementation(function (this: any) {
      return {
        threads: { create: mockThreadsCreate, delete: mockThreadsDelete },
        messages: { create: mockMessagesCreate },
        runs: { create: mockRunsCreate },
      };
    });

    // Default happy-path mocks.
    mockThreadsCreate.mockResolvedValue({ id: 'thread_abc123' });
    mockThreadsDelete.mockResolvedValue({
      id: 'thread_abc123',
      deleted: true,
      object: 'thread.deleted',
    });
    mockMessagesCreate.mockResolvedValue({});
    mockRunsCreate.mockReturnValue({
      stream: () =>
        Promise.resolve(
          makeRunStream([
            deltaEvent('hi'),
            completedEvent,
            runCompletedEvent,
            doneEvent,
          ]),
        ),
    });
  });

  it('deletes the ephemeral thread once after a happy-path stream completes', async () => {
    const handler = new AIFoundryAgentHandler();

    const response = await handler.handleAgentChat(
      testModel.id,
      testModel,
      testMessages,
      0.3,
      testUser,
      undefined,
      undefined,
      { ephemeral: true },
    );
    await drainStream(response);

    await vi.waitFor(() => {
      expect(mockThreadsDelete).toHaveBeenCalledTimes(1);
    });
    expect(mockThreadsDelete).toHaveBeenCalledWith('thread_abc123');
  });

  it('is idempotent — multiple stream exit events trigger delete only once', async () => {
    // Stream emits both `thread.run.completed` AND `done`. Without idempotency,
    // the second event would attempt a redundant delete.
    const handler = new AIFoundryAgentHandler();

    const response = await handler.handleAgentChat(
      testModel.id,
      testModel,
      testMessages,
      0.3,
      testUser,
      undefined,
      undefined,
      { ephemeral: true },
    );
    await drainStream(response);

    await vi.waitFor(() => {
      expect(mockThreadsDelete).toHaveBeenCalledTimes(1);
    });
    // Give any duplicate microtask a chance to fire — still exactly one call.
    await nextTick();
    expect(mockThreadsDelete).toHaveBeenCalledTimes(1);
  });

  it('does NOT delete when ephemeral is not set', async () => {
    const handler = new AIFoundryAgentHandler();

    const response = await handler.handleAgentChat(
      testModel.id,
      testModel,
      testMessages,
      0.3,
      testUser,
      undefined,
      undefined,
    );
    await drainStream(response);

    await nextTick();
    expect(mockThreadsDelete).not.toHaveBeenCalled();
  });

  it('does NOT delete when the caller reuses an existing thread (ephemeral=true)', async () => {
    const handler = new AIFoundryAgentHandler();

    const response = await handler.handleAgentChat(
      testModel.id,
      testModel,
      testMessages,
      0.3,
      testUser,
      undefined,
      'thread_existing_999',
      { ephemeral: true },
    );
    await drainStream(response);

    await nextTick();
    // Reused thread — we did not create it, so we must not delete it.
    expect(mockThreadsCreate).not.toHaveBeenCalled();
    expect(mockThreadsDelete).not.toHaveBeenCalled();
  });

  it('cleans up the thread when messages.create fails before the stream starts', async () => {
    mockMessagesCreate.mockRejectedValueOnce(new Error('boom: message'));
    const handler = new AIFoundryAgentHandler();

    await expect(
      handler.handleAgentChat(
        testModel.id,
        testModel,
        testMessages,
        0.3,
        testUser,
        undefined,
        undefined,
        { ephemeral: true },
      ),
    ).rejects.toThrow('boom: message');

    await vi.waitFor(() => {
      expect(mockThreadsDelete).toHaveBeenCalledWith('thread_abc123');
    });
  });

  it('cleans up the thread when run.stream() fails before the stream starts', async () => {
    mockRunsCreate.mockReturnValueOnce({
      stream: () => Promise.reject(new Error('boom: stream')),
    });
    const handler = new AIFoundryAgentHandler();

    await expect(
      handler.handleAgentChat(
        testModel.id,
        testModel,
        testMessages,
        0.3,
        testUser,
        undefined,
        undefined,
        { ephemeral: true },
      ),
    ).rejects.toThrow('boom: stream');

    await vi.waitFor(() => {
      expect(mockThreadsDelete).toHaveBeenCalledWith('thread_abc123');
    });
  });

  it('cleans up the thread when the stream emits an error event', async () => {
    mockRunsCreate.mockReturnValueOnce({
      stream: () =>
        Promise.resolve(
          makeRunStream([
            deltaEvent('partial'),
            { event: 'error', data: { message: 'agent blew up' } },
          ]),
        ),
    });
    const handler = new AIFoundryAgentHandler();

    const response = await handler.handleAgentChat(
      testModel.id,
      testModel,
      testMessages,
      0.3,
      testUser,
      undefined,
      undefined,
      { ephemeral: true },
    );
    // The stream errors — consume it and expect an error to propagate.
    try {
      await drainStream(response);
    } catch {
      // expected
    }

    await vi.waitFor(() => {
      expect(mockThreadsDelete).toHaveBeenCalledTimes(1);
    });
  });

  it('cleans up the thread when the consumer cancels the response body', async () => {
    // A stream that yields one chunk and then hangs — simulates an in-flight
    // response interrupted by client disconnect.
    let resolveStream: (() => void) | undefined;
    mockRunsCreate.mockReturnValueOnce({
      stream: () =>
        Promise.resolve({
          async *[Symbol.asyncIterator]() {
            yield deltaEvent('first');
            // Wait until the test resolves us — simulates a long-running stream.
            await new Promise<void>((resolve) => {
              resolveStream = resolve;
            });
          },
        }),
    });

    const handler = new AIFoundryAgentHandler();

    const response = await handler.handleAgentChat(
      testModel.id,
      testModel,
      testMessages,
      0.3,
      testUser,
      undefined,
      undefined,
      { ephemeral: true },
    );

    // Read one chunk, then cancel.
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    reader.releaseLock();

    await vi.waitFor(() => {
      expect(mockThreadsDelete).toHaveBeenCalledWith('thread_abc123');
    });

    // Unblock the hanging stream so the test process can exit cleanly.
    resolveStream?.();
  });

  it('swallows errors from threads.delete and still returns a successful response', async () => {
    mockThreadsDelete.mockRejectedValueOnce(new Error('azure 503'));
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const handler = new AIFoundryAgentHandler();
    const response = await handler.handleAgentChat(
      testModel.id,
      testModel,
      testMessages,
      0.3,
      testUser,
      undefined,
      undefined,
      { ephemeral: true },
    );

    expect(response.ok).toBe(true);
    await drainStream(response);

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[AIFoundryAgentHandler] Failed to delete ephemeral thread',
        'thread_abc123',
        expect.any(Error),
      );
    });

    consoleErrorSpy.mockRestore();
  });

  it('treats a 404 from threads.delete as success (no error log)', async () => {
    const err = Object.assign(new Error('Not found'), { statusCode: 404 });
    mockThreadsDelete.mockRejectedValueOnce(err);
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const handler = new AIFoundryAgentHandler();
    const response = await handler.handleAgentChat(
      testModel.id,
      testModel,
      testMessages,
      0.3,
      testUser,
      undefined,
      undefined,
      { ephemeral: true },
    );
    await drainStream(response);

    await vi.waitFor(() => {
      expect(mockThreadsDelete).toHaveBeenCalledTimes(1);
    });
    await nextTick();

    // The "Failed to delete" error path should NOT have fired.
    const failedCalls = consoleErrorSpy.mock.calls.filter(
      (c) =>
        c[0] === '[AIFoundryAgentHandler] Failed to delete ephemeral thread',
    );
    expect(failedCalls).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });

  it('warns when threads.delete returns deleted:false', async () => {
    mockThreadsDelete.mockResolvedValueOnce({
      id: 'thread_abc123',
      deleted: false,
      object: 'thread.deleted',
    });
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    const handler = new AIFoundryAgentHandler();
    const response = await handler.handleAgentChat(
      testModel.id,
      testModel,
      testMessages,
      0.3,
      testUser,
      undefined,
      undefined,
      { ephemeral: true },
    );
    await drainStream(response);

    await vi.waitFor(() => {
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[AIFoundryAgentHandler] Ephemeral thread delete returned deleted=false',
        'thread_abc123',
      );
    });

    consoleWarnSpy.mockRestore();
  });
});
