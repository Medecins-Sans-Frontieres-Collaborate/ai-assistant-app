import {
  ToolLoopProviderStrategy,
  runToolLoopCore,
} from '@/lib/services/mcp/toolLoopCore';

import { parseMetadataFromContent } from '@/lib/utils/app/metadata';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pipeline's model-start timeout (issue #130) races a handler until it
 * RETURNS a Response. The tool loop used to return one instantly and do all
 * its work — including the first model call — inside the stream body, so
 * an MCP turn was never covered by the timeout and a hung model ran until
 * the socket died. The Response is now held back until the strategy reports
 * the model has started (or the loop ends first).
 */

function makeStrategy(
  runModelRound: ToolLoopProviderStrategy<string>['runModelRound'],
): ToolLoopProviderStrategy<string> {
  return {
    reconstructTranscript: (messages) => messages,
    appendToolResults: (messages) => messages,
    runModelRound,
  };
}

const baseOptions = {
  preparedMessages: ['hi'],
  servers: [],
  loopRound: 0,
  userId: 'user-1',
  usage: {
    modelId: 'gpt-5.2',
    region: 'US' as const,
    onUsage: vi.fn(),
  },
};

/** Resolves 'pending' if `promise` has not settled after a macrotask. */
function settledOrPending<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([
    promise,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'))),
  ]);
}

describe('runToolLoopCore model-start gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('holds the Response until the strategy reports the model has started', async () => {
    let started!: () => void;
    let finishRound!: () => void;
    const strategy = makeStrategy(async (_m, _s, _allow, write, onStarted) => {
      write('queued before the model started');
      started = onStarted!;
      await new Promise<void>((resolve) => {
        finishRound = resolve;
      });
      write(' and after');
      return { finishedWithToolUse: false, calls: [], usage: null };
    });

    const pending = runToolLoopCore({ ...baseOptions, strategy });
    // Model not started → no Response yet: this is what the stage timer
    // is racing against.
    expect(await settledOrPending(pending)).toBe('pending');

    started();
    const response = await pending;
    expect(response).toBeInstanceOf(Response);

    // Text written before the gate opened was queued, not lost.
    finishRound();
    expect(await response.text()).toContain(
      'queued before the model started and after',
    );
  });

  it('still returns the Response when the loop fails before any model round', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const strategy = makeStrategy(async () => {
      throw new Error('provider refused before streaming');
    });

    const response = await runToolLoopCore({ ...baseOptions, strategy });
    const parsed = parseMetadataFromContent(await response.text());
    expect(parsed.streamError?.code).toBe('TOOL_LOOP_FAILED');
  });

  it('returns the Response once the stream ends even if a strategy never signals (legacy shape)', async () => {
    const strategy = makeStrategy(async (_m, _s, _allow, write) => {
      write('Hello');
      return { finishedWithToolUse: false, calls: [], usage: null };
    });

    const response = await runToolLoopCore({ ...baseOptions, strategy });
    expect(await response.text()).toContain('Hello');
  });
});
