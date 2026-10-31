import type { SkillToolExecutor } from './skillTools';

import { emitToolCallRecord } from '@/lib/streamMarkers';

export interface FoundrySkillCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}
export interface FoundrySkillOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}
export interface FoundrySkillEvent {
  type: string;
  item?: unknown;
  response?: {
    output?: unknown[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    error?: { message: string };
  };
  marker?: string;
  [key: string]: unknown;
}

/**
 * Continues a registered Foundry function call without replacing agent_reference
 * or injecting tools into its request (a combination Foundry rejects).
 * At most three skill execution rounds plus a final answer round are allowed.
 * At the cap the pending calls are answered with the executor's own
 * "step limit reached" results and the agent gets ONE more round to answer
 * from what it has (the shared tool loop withholds tools the same way);
 * only a further skill call after that fails the turn.
 */
export async function* runFoundrySkillLoop(
  initial: AsyncIterable<FoundrySkillEvent>,
  next: (
    outputs: FoundrySkillOutput[],
  ) => Promise<AsyncIterable<FoundrySkillEvent>>,
  executor: SkillToolExecutor,
): AsyncGenerator<FoundrySkillEvent> {
  let stream = initial;
  let rounds = 0;
  let capAnswered = false;
  const aggregate = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  while (true) {
    const calls = new Map<string, FoundrySkillCall>();
    let completed: FoundrySkillEvent | undefined;
    for await (const event of stream) {
      if (event.type === 'response.output_item.done') {
        const item = event.item as FoundrySkillCall | undefined;
        if (
          item?.type === 'function_call' &&
          ['load_skill', 'search_skill_documents'].includes(item.name)
        )
          calls.set(item.call_id, item);
      }
      if (event.type === 'response.completed') {
        completed = event;
        for (const item of event.response?.output ?? []) {
          const call = item as FoundrySkillCall;
          if (
            call.type === 'function_call' &&
            ['load_skill', 'search_skill_documents'].includes(call.name)
          )
            calls.set(call.call_id, call);
        }
        const usage = event.response?.usage;
        aggregate.input_tokens += usage?.input_tokens ?? 0;
        aggregate.output_tokens += usage?.output_tokens ?? 0;
        aggregate.total_tokens +=
          usage?.total_tokens ??
          (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
      } else yield event;
    }
    if (!completed) return;
    if (!calls.size) {
      yield {
        ...completed,
        response: { ...completed.response, usage: aggregate },
      };
      return;
    }
    const atCap = rounds >= 3 || executor.remainingRounds() === 0;
    if (atCap && capAnswered) {
      yield {
        type: 'response.failed',
        response: {
          error: {
            message:
              'Agent skill step limit reached. No additional skill calls were executed.',
          },
        },
      };
      return;
    }
    const outputs: FoundrySkillOutput[] = [];
    for (const call of [...calls.values()].slice(0, 100)) {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        args = null;
      }
      const result = await executor.callTool(call.name, args);
      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: result.resultText,
      });
      // The browser record carries a summary, never the instruction body.
      const shown =
        executor.recordOutput?.(call.name, args, result) ?? result.resultText;
      yield {
        type: 'skill.tool_record',
        marker: emitToolCallRecord({
          id: call.call_id,
          name: call.name,
          server_label: 'Skills',
          arguments: call.arguments,
          status: result.isError ? 'failed' : 'completed',
          output: shown,
          error: result.isError ? shown : null,
        }),
      };
    }
    if (calls.size > 100) {
      yield {
        type: 'response.failed',
        response: {
          error: { message: 'Agent returned too many skill calls.' },
        },
      };
      return;
    }
    if (atCap) {
      // The executor answered every call with its limit notice (it refuses
      // past its round cap); the agent now gets its final answer round.
      capAnswered = true;
    } else {
      executor.completeRound();
      rounds += 1;
    }
    stream = await next(outputs);
  }
}
