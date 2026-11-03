import { readContinuationState } from '@/lib/services/limits/continuationToken';
import { connectMcp } from '@/lib/services/mcp/McpClientService';
import type { BuiltinExecutor } from '@/lib/services/mcp/builtinExecutor';
import {
  ToolLoopProviderStrategy,
  runToolLoopCore,
} from '@/lib/services/mcp/toolLoopCore';
import { toModelToolName } from '@/lib/services/mcp/toolNameMapping';
import {
  SKILL_SERVER_ID,
  buildSkillServer,
} from '@/lib/services/skills/skillTools';

import { scanStreamEvents } from '@/lib/streamMarkers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/mcp/McpClientService', () => ({
  connectMcp: vi.fn(),
  isMcpAuthError: () => false,
}));
const usage = {
  modelId: 'test-model',
  region: 'EU' as const,
  onUsage: vi.fn(),
};
const tool = { name: 'load_skill', inputSchema: { type: 'object' } };

describe('read-only skill loop alongside MCP', () => {
  beforeEach(() => vi.clearAllMocks());
  it('executes only skills immediately in a mixed call batch and signs their budgets into the connector pause', async () => {
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    const connection = {
      listTools: vi.fn(async () => [
        { name: 'read', inputSchema: { type: 'object' } },
      ]),
      close: vi.fn(),
      callTool: vi.fn(),
    };
    vi.mocked(connectMcp).mockResolvedValue(connection as never);
    const executor: BuiltinExecutor = {
      immediate: true,
      instructions: '',
      listTools: async () => [tool],
      callTool: vi.fn(async () => ({ resultText: 'Guidance', isError: false })),
      continuationState: () => ({
        loads: 1,
        searches: 0,
        rounds: 1,
        loaded: ['gdpr'],
      }),
    };
    const strategy: ToolLoopProviderStrategy<string> = {
      reconstructTranscript: (messages) => messages,
      appendToolResults: (messages) => messages,
      runModelRound: async (_messages, _servers, _allow, _write, started) => {
        started?.();
        return {
          finishedWithToolUse: true,
          calls: [
            {
              id: 'skill-call',
              name: toModelToolName(SKILL_SERVER_ID, 'load_skill'),
              argumentsJson: '{}',
            },
            { id: 'network-call', name: 'network__read', argumentsJson: '{}' },
          ],
          usage: null,
        };
      },
    };
    const network = {
      ...buildSkillServer(),
      id: 'network',
      label: 'Connector',
      url: 'https://example.test/mcp',
      provenance: undefined,
    };
    const response = await runToolLoopCore({
      strategy,
      preparedMessages: [],
      servers: [buildSkillServer(), network],
      builtinExecutors: { [SKILL_SERVER_ID]: executor },
      loopRound: 0,
      userId: 'user',
      usage,
    });
    const { events } = scanStreamEvents(await response.text(), 0);
    const consent = events.filter((event) => event.type === 'consent_request');
    expect(consent).toHaveLength(1);
    expect(consent[0].payload.approval_request_id).toBe('network-call');
    expect(
      readContinuationState(
        'user',
        'network-call',
        consent[0].payload.continuation_token,
      )?.[SKILL_SERVER_ID],
    ).toMatchObject({ loads: 1, rounds: 1 });
    expect(connection.callTool).not.toHaveBeenCalled();
    expect(executor.callTool).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });
  it('executes a skill immediately and continues to the answer with no approval card', async () => {
    const callTool = vi.fn(async () => ({
      resultText: 'Real guidance',
      isError: false,
    }));
    const executor: BuiltinExecutor = {
      immediate: true,
      instructions: '',
      listTools: async () => [tool],
      callTool,
    };
    let rounds = 0;
    const strategy: ToolLoopProviderStrategy<string> = {
      reconstructTranscript: (messages, calls) => [
        ...messages,
        `calls:${calls.length}`,
      ],
      appendToolResults: (messages, results) => [
        ...messages,
        ...results.map((result) => result.text),
      ],
      runModelRound: async (messages, _servers, _allow, write, started) => {
        started?.();
        rounds++;
        if (rounds === 1)
          return {
            finishedWithToolUse: true,
            calls: [
              {
                id: 'call',
                name: toModelToolName(SKILL_SERVER_ID, 'load_skill'),
                argumentsJson: '{"id":"gdpr"}',
              },
            ],
            usage: null,
          };
        expect(messages).toContain('Real guidance');
        write('Final answer');
        return { finishedWithToolUse: false, calls: [], usage: null };
      },
    };
    const response = await runToolLoopCore({
      strategy,
      preparedMessages: ['User request'],
      servers: [buildSkillServer()],
      builtinExecutors: { [SKILL_SERVER_ID]: executor },
      userId: 'user',
      loopRound: 0,
      usage,
    });
    const output = await response.text();
    expect(output).toContain('Final answer');
    expect(output).not.toContain('<<<CONSENT_REQUEST>>>');
    expect(callTool).toHaveBeenCalledOnce();
    expect(connectMcp).not.toHaveBeenCalled();
  });
  it('stops offering skill tools after a strict independent internal round cap', async () => {
    const executor: BuiltinExecutor = {
      immediate: true,
      instructions: '',
      listTools: async () => [tool],
      callTool: vi.fn(async () => ({ resultText: 'Guidance', isError: false })),
    };
    const strategy: ToolLoopProviderStrategy<string> = {
      reconstructTranscript: (messages) => messages,
      appendToolResults: (messages) => messages,
      runModelRound: vi.fn(
        async (_messages, servers, _allow, write, started) => {
          started?.();
          if (!servers[0].tools.length) {
            write('Answer with available information');
            return { finishedWithToolUse: false, calls: [], usage: null };
          }
          return {
            finishedWithToolUse: true,
            calls: [
              {
                id: `call-${Date.now()}`,
                name: toModelToolName(SKILL_SERVER_ID, 'load_skill'),
                argumentsJson: '{}',
              },
            ],
            usage: null,
          };
        },
      ),
    };
    const response = await runToolLoopCore({
      strategy,
      preparedMessages: [],
      servers: [buildSkillServer()],
      builtinExecutors: { [SKILL_SERVER_ID]: executor },
      maxImmediateRounds: 2,
      loopRound: 0,
      maxRounds: 5,
      userId: 'user',
      usage,
    });
    expect(await response.text()).toContain(
      'Answer with available information',
    );
    expect(executor.callTool).toHaveBeenCalledTimes(2);
    expect(strategy.runModelRound).toHaveBeenCalledTimes(3);
  });
});
