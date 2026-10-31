import type { M365BuiltinExecutor } from '@/lib/services/m365/tools/executor';
import { connectMcp } from '@/lib/services/mcp/McpClientService';
import {
  TOOL_CALL_BUDGET_MS,
  ToolLoopProviderStrategy,
  runToolLoopCore,
} from '@/lib/services/mcp/toolLoopCore';

import { parseMetadataFromContent } from '@/lib/utils/app/metadata';

import { ResolvedMcpServer } from '@/config/mcpCatalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/mcp/McpClientService', () => ({
  connectMcp: vi.fn(),
  isMcpAuthError: vi.fn(() => false),
}));
vi.mock('@/lib/services/mcp/McpToolCache', () => ({
  getCachedTools: vi.fn(() => null),
  setCachedTools: vi.fn(),
}));

/**
 * Cancellation and budgets inside the tool loop. Without these, a Stop /
 * tab close / network drop left the loop running to completion unseen
 * (metered, side effects executed), and a hanging connector stalled the
 * turn until the model-stage timer fired — which the client then reported
 * as "the model did not start responding".
 */

const builtinServer: ResolvedMcpServer = {
  id: 'builtin-m365',
  label: 'Microsoft 365',
  url: '',
  provenance: 'builtin',
  auth: { mode: 'none' },
} as unknown as ResolvedMcpServer;

function makeExecutor(
  callTool: M365BuiltinExecutor['callTool'],
): M365BuiltinExecutor {
  return {
    listTools: vi.fn(async () => [
      {
        name: 'mail_send',
        description: 'Send mail',
        inputSchema: { type: 'object', properties: {} },
      },
    ]),
    callTool: vi.fn(callTool),
  } as unknown as M365BuiltinExecutor;
}

const strategy: ToolLoopProviderStrategy<string> = {
  reconstructTranscript: (messages) => messages,
  appendToolResults: (messages) => messages,
  runModelRound: async (_m, _s, _allow, write) => {
    write('answer');
    return { finishedWithToolUse: false, calls: [], usage: null };
  },
};

const baseOptions = {
  strategy,
  preparedMessages: ['hi'],
  loopRound: 1,
  userId: 'user-1',
  usage: { modelId: 'gpt-5.2', region: 'US' as const, onUsage: vi.fn() },
  servers: [builtinServer],
  pendingToolCalls: [
    {
      id: 'call_1',
      serverId: 'builtin-m365',
      toolName: 'mail_send',
      argumentsJson: '{}',
    },
  ],
  approvalResponses: [{ approval_request_id: 'call_1', approve: true }],
};

describe('runToolLoopCore — cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not dispatch an approved tool call when the request is already aborted', async () => {
    const executor = makeExecutor(async () => ({
      resultText: 'sent',
      isError: false,
    }));
    const abort = new AbortController();
    abort.abort(new Error('Client disconnected'));

    const response = await runToolLoopCore<string>({
      ...baseOptions,
      builtinExecutor: executor,
      signal: abort.signal,
    });
    const text = await response.text();

    expect(executor.callTool).not.toHaveBeenCalled();
    expect(connectMcp).not.toHaveBeenCalled();
    // Nobody is listening: the stream ends quietly, no in-band error.
    expect(parseMetadataFromContent(text).streamError).toBeUndefined();
    expect(text).not.toContain('answer');
  });

  it('records a tool call that overruns its budget as failed and lets the model continue', async () => {
    vi.useFakeTimers();
    const executor = makeExecutor(
      () => new Promise(() => {}), // never resolves
    );

    const pending = runToolLoopCore<string>({
      ...baseOptions,
      builtinExecutor: executor,
    });
    await vi.advanceTimersByTimeAsync(TOOL_CALL_BUDGET_MS + 1);
    const response = await pending;
    vi.useRealTimers();
    const text = await response.text();

    expect(executor.callTool).toHaveBeenCalledTimes(1);
    expect(text).toContain('did not finish within');
    // The model round still ran — the turn is not lost.
    expect(text).toContain('answer');
    expect(parseMetadataFromContent(text).streamError).toBeUndefined();
  });
});
