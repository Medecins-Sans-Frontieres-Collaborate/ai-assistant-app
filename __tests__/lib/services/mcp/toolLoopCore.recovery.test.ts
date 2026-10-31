import type { M365BuiltinExecutor } from '@/lib/services/m365/tools/executor';
import {
  MAX_MODEL_TOOL_RESULT_CHARS,
  TOOL_CALL_CONCURRENCY,
  ToolLoopProviderStrategy,
  capToolResultForModel,
  runToolLoopCore,
} from '@/lib/services/mcp/toolLoopCore';

import { parseMetadataFromContent } from '@/lib/utils/app/metadata';

import { ResolvedMcpServer } from '@/config/mcpCatalog';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/mcp/McpClientService', () => ({
  connectMcp: vi.fn(),
  isMcpAuthError: vi.fn(() => false),
}));
vi.mock('@/lib/services/mcp/McpToolCache', () => ({
  getCachedTools: vi.fn(() => null),
  setCachedTools: vi.fn(),
}));

/**
 * In-turn recovery inside the tool loop (modelRetry + streamContinuation):
 * a failed round is retried, continued, or trimmed instead of ending the
 * turn, and approved tool calls run concurrently with results kept in
 * order. Retry delays are zeroed by vitest.setup.node.ts.
 */

/** Visible text only: strips loader markers and the terminal metadata block. */
function visible(text: string): string {
  return text
    .replace(/<<<AGENT_ACTIVITY>>>[\s\S]*?<<<END_AGENT_ACTIVITY>>>/g, '')
    .replace(/<<<METADATA_START>>>[\s\S]*?<<<METADATA_END>>>/g, '')
    .replace(/\n\n/g, '');
}

const baseOptions = {
  preparedMessages: ['hi'],
  servers: [] as ResolvedMcpServer[],
  loopRound: 0,
  userId: 'user-1',
  usage: { modelId: 'gpt-5.2', region: 'US' as const, onUsage: vi.fn() },
};

function strategyWith(
  runModelRound: ToolLoopProviderStrategy<string>['runModelRound'],
  extra: Partial<ToolLoopProviderStrategy<string>> = {},
): ToolLoopProviderStrategy<string> {
  return {
    reconstructTranscript: (messages) => messages,
    appendToolResults: (messages) => messages,
    runModelRound,
    ...extra,
  };
}

describe('runToolLoopCore in-turn recovery', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('retries a rate-limited round before any text and announces the wait', async () => {
    let calls = 0;
    const strategy = strategyWith(async (_m, _s, _a, write) => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(new Error('429'), {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      write('answer');
      return { finishedWithToolUse: false, calls: [], usage: null };
    });
    const text = await (
      await runToolLoopCore({ ...baseOptions, strategy })
    ).text();
    expect(calls).toBe(2);
    expect(text).toContain('chat.activity.retryingModel');
    expect(text).toContain('answer');
    expect(parseMetadataFromContent(text).streamError).toBeUndefined();
  });

  it('continues from the partial text when the round dies after streaming', async () => {
    let calls = 0;
    const appendContinuation = vi.fn(
      (messages: string[], partial: string, reason: string) => [
        ...messages,
        `assistant:${partial}`,
        `user:${reason}`,
      ],
    );
    const strategy = strategyWith(
      async (messages, _s, _a, write) => {
        calls += 1;
        if (calls === 1) {
          write('Hello');
          throw Object.assign(new Error('socket hang up'), {
            code: 'ECONNRESET',
          });
        }
        expect(messages).toContain('assistant:Hello');
        write(' world');
        return { finishedWithToolUse: false, calls: [], usage: null };
      },
      { appendContinuation },
    );
    const text = await (
      await runToolLoopCore({ ...baseOptions, strategy })
    ).text();
    expect(text).toContain('Hello');
    expect(text).toContain(' world');
    expect(text).toContain('chat.activity.resumingResponse');
    expect(appendContinuation).toHaveBeenCalledWith(
      expect.any(Array),
      'Hello',
      'interrupted',
    );
    expect(parseMetadataFromContent(text).streamError).toBeUndefined();
  });

  it('continues an output-limited round and merges usage', async () => {
    let calls = 0;
    const strategy = strategyWith(
      async (_m, _s, _a, write) => {
        calls += 1;
        if (calls === 1) {
          write('Part 1');
          return {
            finishedWithToolUse: false,
            finish: 'length',
            calls: [],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          };
        }
        write(' Part 2');
        return {
          finishedWithToolUse: false,
          finish: 'stop',
          calls: [],
          usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
        };
      },
      { appendContinuation: (m, partial) => [...m, partial] },
    );
    const text = await (
      await runToolLoopCore({ ...baseOptions, strategy })
    ).text();
    expect(visible(text)).toContain('Part 1 Part 2');
    expect(text).toContain('chat.activity.continuingResponse');
    expect(parseMetadataFromContent(text).usage).toMatchObject({
      promptTokens: 30,
      completionTokens: 10,
      totalTokens: 40,
    });
  });

  it('shrinks the transcript on a context overflow and retries', async () => {
    let calls = 0;
    const shrinkForOverflow = vi.fn((messages: string[]) =>
      messages.length > 1 ? messages.slice(1) : null,
    );
    const strategy = strategyWith(
      async (messages, _s, _a, write) => {
        calls += 1;
        if (calls === 1)
          throw Object.assign(new Error('context_length_exceeded'), {
            status: 400,
            code: 'context_length_exceeded',
          });
        expect(messages).toEqual(['current']);
        write('fits now');
        return { finishedWithToolUse: false, calls: [], usage: null };
      },
      { shrinkForOverflow },
    );
    const text = await (
      await runToolLoopCore({
        ...baseOptions,
        preparedMessages: ['old', 'current'],
        strategy,
      })
    ).text();
    expect(text).toContain('fits now');
    expect(text).toContain('chat.activity.trimmingContext');
    expect(shrinkForOverflow).toHaveBeenCalledTimes(1);
  });

  it('ends the turn with the content-filter error on a filtered finish', async () => {
    const strategy = strategyWith(async (_m, _s, _a, write) => {
      write('I will');
      return {
        finishedWithToolUse: false,
        finish: 'content_filter',
        calls: [],
        usage: null,
      };
    });
    const text = await (
      await runToolLoopCore({ ...baseOptions, strategy })
    ).text();
    expect(parseMetadataFromContent(text).streamError).toMatchObject({
      code: 'MODEL_CONTENT_FILTERED',
      kind: 'content_filter',
    });
  });

  it('surfaces a non-retryable round failure immediately with its kind', async () => {
    let calls = 0;
    const strategy = strategyWith(async () => {
      calls += 1;
      throw Object.assign(new Error('bad request'), { status: 400 });
    });
    const text = await (
      await runToolLoopCore({ ...baseOptions, strategy })
    ).text();
    expect(calls).toBe(1);
    expect(parseMetadataFromContent(text).streamError).toMatchObject({
      code: 'TOOL_LOOP_FAILED',
      kind: 'invalid_request',
    });
  });
});

describe('approved tool calls run concurrently, results stay ordered', () => {
  const builtinServer: ResolvedMcpServer = {
    id: 'builtin-m365',
    label: 'Microsoft 365',
    url: '',
    provenance: 'builtin',
    auth: { mode: 'none' },
  } as unknown as ResolvedMcpServer;

  it(`runs up to ${TOOL_CALL_CONCURRENCY} calls at once and feeds results back in pending order`, async () => {
    let inFlight = 0;
    let peak = 0;
    const executor = {
      listTools: vi.fn(async () => [
        {
          name: 'slow',
          description: 'slow tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ]),
      callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, Number(args.ms)));
        inFlight -= 1;
        return { resultText: `done ${args.ms}`, isError: false };
      }),
    } as unknown as M365BuiltinExecutor;

    const appendToolResults = vi.fn((messages: string[], results) => [
      ...messages,
      ...results.map((r: { text: string }) => r.text),
    ]);
    const strategy = strategyWith(
      async (messages, _s, _a, write) => {
        write(messages.join('|'));
        return { finishedWithToolUse: false, calls: [], usage: null };
      },
      { appendToolResults },
    );
    const pending = [60, 10, 30].map((ms, i) => ({
      id: `call_${i}`,
      serverId: 'builtin-m365',
      toolName: 'slow',
      argumentsJson: JSON.stringify({ ms }),
    }));
    const started = Date.now();
    const text = await (
      await runToolLoopCore({
        ...baseOptions,
        strategy,
        loopRound: 1,
        servers: [builtinServer],
        builtinExecutors: { 'builtin-m365': executor },
        pendingToolCalls: pending,
        approvalResponses: pending.map((p) => ({
          approval_request_id: p.id,
          approve: true,
        })),
      })
    ).text();
    const elapsed = Date.now() - started;
    expect(peak).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(60 + 10 + 30);
    const results = appendToolResults.mock.calls[0][1] as { text: string }[];
    expect(results.map((r) => r.text)).toEqual([
      'done 60',
      'done 10',
      'done 30',
    ]);
    expect(text).toContain('done 60|done 10|done 30');
  });
});

describe('capToolResultForModel', () => {
  it('passes short results through and truncates long ones with a trailer', () => {
    expect(capToolResultForModel('short')).toBe('short');
    const long = 'x'.repeat(MAX_MODEL_TOOL_RESULT_CHARS + 500);
    const capped = capToolResultForModel(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped).toContain('Tool result truncated: 500 more characters');
  });
});
