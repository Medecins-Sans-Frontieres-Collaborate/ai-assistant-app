/**
 * Immediate (builtin) executors can still demand approval per call
 * (docs/SKILLS_DESIGN.md §5.5): a consent-gated skill load pauses the turn
 * like a connector call, and the browser record carries the executor's
 * summary rather than the raw result.
 */
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
import { describe, expect, it, vi } from 'vitest';

const usage = {
  modelId: 'test-model',
  region: 'EU' as const,
  onUsage: vi.fn(),
};

function strategyWith(
  calls: { id: string; args: Record<string, unknown> }[],
): ToolLoopProviderStrategy<string> {
  let round = 0;
  return {
    reconstructTranscript: (messages) => messages,
    appendToolResults: (messages) => messages,
    runModelRound: async (_messages, _servers, _allow, write, started) => {
      started?.();
      round += 1;
      if (round > 1) {
        write('done');
        return { finishedWithToolUse: false, calls: [], usage: null };
      }
      return {
        finishedWithToolUse: true,
        calls: calls.map((call) => ({
          id: call.id,
          name: toModelToolName(SKILL_SERVER_ID, 'load_skill'),
          argumentsJson: JSON.stringify(call.args),
        })),
        usage: null,
      };
    },
  };
}

describe('builtin executors with per-call approval', () => {
  it('pauses for a consent-gated load, runs the open one, and hides the body in the record', async () => {
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    const executor: BuiltinExecutor = {
      immediate: true,
      instructions: '',
      listTools: async () => [
        { name: 'load_skill', inputSchema: { type: 'object' } },
      ],
      callTool: vi.fn(async () => ({
        resultText: 'FULL INSTRUCTION BODY',
        isError: false,
      })),
      requiresApproval: (_name, args) => args.id === 'careful',
      recordOutput: (_name, args) => `Loaded skill ${String(args.id)}.`,
      continuationState: () => ({
        loads: 1,
        searches: 0,
        rounds: 1,
        loaded: [],
      }),
    };
    const response = await runToolLoopCore({
      strategy: strategyWith([
        { id: 'open-call', args: { id: 'open' } },
        { id: 'careful-call', args: { id: 'careful' } },
      ]),
      preparedMessages: [],
      servers: [buildSkillServer()],
      builtinExecutors: { [SKILL_SERVER_ID]: executor },
      loopRound: 0,
      userId: 'user',
      usage,
    });
    const text = await response.text();
    const { events } = scanStreamEvents(text, 0);
    const consent = events.filter((event) => event.type === 'consent_request');
    expect(consent).toHaveLength(1);
    expect(consent[0].payload.approval_request_id).toBe('careful-call');
    expect(executor.callTool).toHaveBeenCalledTimes(1);
    expect(text).toContain('Loaded skill open.');
    expect(text).not.toContain('FULL INSTRUCTION BODY');
    vi.unstubAllEnvs();
  });
});
