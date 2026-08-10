import type { M365BuiltinExecutor } from '@/lib/services/m365/tools/executor';
import { connectMcp } from '@/lib/services/mcp/McpClientService';
import {
  ExecutedToolResult,
  ToolLoopProviderStrategy,
  listToolsForServers,
  runToolLoopCore,
} from '@/lib/services/mcp/toolLoopCore';

import { ResolvedMcpServer } from '@/config/mcpCatalog';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/mcp/McpClientService', () => ({
  connectMcp: vi.fn(),
  isMcpAuthError: () => false,
}));

const builtinServer: ResolvedMcpServer = {
  id: 'builtin-m365',
  label: 'Microsoft 365',
  url: '',
  transport: 'streamable-http',
  auth: { style: 'none' },
  trusted: true,
  provenance: 'builtin',
};

function makeExecutor(
  overrides: Partial<M365BuiltinExecutor> = {},
): M365BuiltinExecutor {
  return {
    instructions: 'Use person_resolve before addressing people.',
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'calendar_list_events',
        description: 'List events',
        inputSchema: { type: 'object', properties: {} },
      },
    ]),
    callTool: vi
      .fn()
      .mockResolvedValue({ resultText: '3 events found', isError: false }),
    ...overrides,
  };
}

describe('listToolsForServers — builtin branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists tools in-process via the executor (no MCP connection)', async () => {
    const executor = makeExecutor();
    const { serversWithTools, failedLabels } = await listToolsForServers(
      [builtinServer],
      'user-1',
      executor,
    );

    expect(connectMcp).not.toHaveBeenCalled();
    expect(failedLabels).toEqual([]);
    expect(serversWithTools).toEqual([
      {
        server: builtinServer,
        tools: [
          {
            name: 'calendar_list_events',
            description: 'List events',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        instructions: 'Use person_resolve before addressing people.',
      },
    ]);
  });

  it('degrades to zero tools when the executor listing fails', async () => {
    const executor = makeExecutor({
      listTools: vi.fn().mockRejectedValue(new Error('probe failed')),
    });
    const { serversWithTools, failedLabels } = await listToolsForServers(
      [builtinServer],
      'user-1',
      executor,
    );

    expect(failedLabels).toEqual(['Microsoft 365']);
    expect(serversWithTools).toEqual([{ server: builtinServer, tools: [] }]);
  });

  it('degrades to zero tools when no executor is provided for a builtin server', async () => {
    const { serversWithTools } = await listToolsForServers(
      [builtinServer],
      'user-1',
    );
    expect(connectMcp).not.toHaveBeenCalled();
    expect(serversWithTools).toEqual([{ server: builtinServer, tools: [] }]);
  });
});

describe('runToolLoopCore — builtin dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeStrategy(captured: { results: ExecutedToolResult[][] }): {
    strategy: ToolLoopProviderStrategy<string>;
  } {
    return {
      strategy: {
        reconstructTranscript: (messages) => messages,
        appendToolResults: (messages, results) => {
          captured.results.push(results);
          return messages;
        },
        runModelRound: async (_m, _s, _allow, write) => {
          write('done');
          return { finishedWithToolUse: false, calls: [], usage: null };
        },
      },
    };
  }

  const baseOptions = {
    preparedMessages: ['hi'],
    loopRound: 1,
    userId: 'user-1',
    usage: {
      modelId: 'gpt-5.2',
      region: 'US' as const,
      onUsage: vi.fn(),
    },
  };

  it('executes approved builtin calls via the executor without opening a connection', async () => {
    const executor = makeExecutor();
    const captured = { results: [] as ExecutedToolResult[][] };
    const { strategy } = makeStrategy(captured);

    const response = await runToolLoopCore<string>({
      ...baseOptions,
      strategy,
      servers: [builtinServer],
      builtinExecutor: executor,
      pendingToolCalls: [
        {
          id: 'call_1',
          serverId: 'builtin-m365',
          toolName: 'calendar_list_events',
          argumentsJson: '{"startDate":"2026-08-01","endDate":"2026-08-02"}',
        },
      ],
      approvalResponses: [{ approval_request_id: 'call_1', approve: true }],
    });
    const text = await response.text();

    expect(connectMcp).not.toHaveBeenCalled();
    expect(executor.callTool).toHaveBeenCalledWith(
      'calendar_list_events',
      {
        startDate: '2026-08-01',
        endDate: '2026-08-02',
      },
      expect.objectContaining({ emitActivity: expect.any(Function) }),
    );
    expect(captured.results).toEqual([
      [
        expect.objectContaining({
          text: '3 events found',
          isError: false,
        }),
      ],
    ]);
    // The TOOL_CALL_RECORD marker rides the stream with the server label.
    expect(text).toContain('Microsoft 365');
    expect(text).toContain('3 events found');
  });

  it('maps executor isError results onto the standard failure text', async () => {
    const executor = makeExecutor({
      callTool: vi.fn().mockResolvedValue({
        resultText: 'Graph is throttling; try again shortly.',
        isError: true,
      }),
    });
    const captured = { results: [] as ExecutedToolResult[][] };
    const { strategy } = makeStrategy(captured);

    await runToolLoopCore<string>({
      ...baseOptions,
      strategy,
      servers: [builtinServer],
      builtinExecutor: executor,
      pendingToolCalls: [
        {
          id: 'call_1',
          serverId: 'builtin-m365',
          toolName: 'tasks_list',
          argumentsJson: '{}',
        },
      ],
      approvalResponses: [{ approval_request_id: 'call_1', approve: true }],
    }).then((r) => r.text());

    expect(captured.results[0][0]).toEqual(
      expect.objectContaining({
        text: 'Tool failed: Graph is throttling; try again shortly.',
        isError: true,
      }),
    );
  });
});
