import {
  FoundrySkillEvent,
  runFoundrySkillLoop,
} from '@/lib/services/skills/foundrySkillLoop';
import type { SkillToolExecutor } from '@/lib/services/skills/skillTools';

import { describe, expect, it, vi } from 'vitest';

async function* events(...values: FoundrySkillEvent[]) {
  yield* values;
}
const call = {
  type: 'function_call',
  name: 'load_skill',
  call_id: 'call-1',
  arguments: '{"id":"gdpr"}',
};
function executor(): SkillToolExecutor {
  return {
    instructions: '',
    listTools: async () => [],
    remainingRounds: () => 3,
    completeRound: vi.fn(),
    callTool: vi.fn(async () => ({
      resultText: 'Skill guidance',
      isError: false,
    })),
  };
}
describe('Foundry registered function dispatch', () => {
  it('submits real outputs and forwards only the final completion', async () => {
    const ex = executor();
    const next = vi.fn(async () =>
      events(
        { type: 'response.output_text.delta', delta: 'Answer' },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 3, output_tokens: 2 } },
        },
      ),
    );
    const output = [];
    for await (const event of runFoundrySkillLoop(
      events(
        { type: 'response.output_item.done', item: call },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 2, output_tokens: 1 } },
        },
      ),
      next,
      ex,
    ))
      output.push(event);
    expect(next).toHaveBeenCalledWith([
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Skill guidance',
      },
    ]);
    expect(
      output.filter((event) => event.type === 'response.completed'),
    ).toHaveLength(1);
    expect(output.at(-1)?.response?.usage?.input_tokens).toBe(5);
    expect(output.some((event) => event.type === 'skill.tool_record')).toBe(
      true,
    );
  });
  it('fails safely if an agent continues calling after the independent step cap', async () => {
    const ex = executor();
    const round = () =>
      events({ type: 'response.completed', response: { output: [call] } });
    const next = vi.fn(async () => round());
    const output = [];
    for await (const event of runFoundrySkillLoop(round(), next, ex))
      output.push(event);
    // Three real rounds, then ONE cap round whose outputs are the
    // executor's limit notices (callTool refuses past its cap) and the
    // agent gets a final answer round; a further call after that fails.
    expect(ex.callTool).toHaveBeenCalledTimes(4);
    expect(ex.completeRound).toHaveBeenCalledTimes(3);
    expect(output.at(-1)?.type).toBe('response.failed');
    expect(next).toHaveBeenCalledTimes(4);
  });
  it('lets the agent answer from what it has when it hits the step cap (no hard failure)', async () => {
    const ex = executor();
    let rounds = 0;
    const callingRound = () =>
      events({ type: 'response.completed', response: { output: [call] } });
    const answerRound = () =>
      events({
        type: 'response.completed',
        response: { output: [], usage: { input_tokens: 1 } },
      });
    // Rounds 1-3 call skills; the cap round (4th model turn) answers.
    const next = vi.fn(async () =>
      ++rounds >= 4 ? answerRound() : callingRound(),
    );
    const output = [];
    for await (const event of runFoundrySkillLoop(callingRound(), next, ex))
      output.push(event);
    expect(output.some((event) => event.type === 'response.failed')).toBe(
      false,
    );
    expect(output.at(-1)?.type).toBe('response.completed');
    expect(next).toHaveBeenCalledTimes(4);
  });
});
