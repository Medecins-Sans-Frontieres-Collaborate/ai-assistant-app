import {
  ToolLoopProviderStrategy,
  runToolLoopCore,
} from '@/lib/services/mcp/toolLoopCore';

import { parseMetadataFromContent } from '@/lib/utils/app/metadata';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A mid-loop crash must end the stream CLEANLY with an in-band streamError
 * metadata block. The old behavior — controller.error() — aborted the
 * response mid-transfer, which browsers surface as an opaque network
 * failure (Firefox: NS_ERROR_NET_PARTIAL_TRANSFER) with zero context, and
 * left nothing in the server logs either.
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

async function readAll(response: Response): Promise<string> {
  return await response.text();
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

describe('runToolLoopCore mid-stream failure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('ends the stream cleanly with a streamError metadata block', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const strategy = makeStrategy(async () => {
      throw new Error('model exploded');
    });

    const response = await runToolLoopCore({ ...baseOptions, strategy });
    // The stream must be fully readable — no abort.
    const text = await readAll(response);

    const parsed = parseMetadataFromContent(text);
    expect(parsed.streamError).toEqual({
      code: 'TOOL_LOOP_FAILED',
      message: expect.stringContaining('interrupted'),
    });
    // The provider error must never reach the wire…
    expect(text).not.toContain('model exploded');
    // …but MUST reach the server logs, or the failure is undiagnosable.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[toolLoopCore]'),
      expect.stringContaining('model exploded'),
    );
  });

  it('streams normally when the round succeeds', async () => {
    const strategy = makeStrategy(async (_m, _s, _allow, write) => {
      write('Hello there');
      return { finishedWithToolUse: false, calls: [], usage: null };
    });

    const response = await runToolLoopCore({ ...baseOptions, strategy });
    const text = await readAll(response);

    expect(text).toContain('Hello there');
    expect(parseMetadataFromContent(text).streamError).toBeUndefined();
  });
});
