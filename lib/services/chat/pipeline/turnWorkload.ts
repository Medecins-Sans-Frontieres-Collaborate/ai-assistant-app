import {
  interpreterRequested,
  nativeInterpreterCapable,
} from '@/lib/services/chat/enrichers/interpreterCapability';
import { searchRequested } from '@/lib/services/chat/enrichers/searchRequest';
import { selectInterpreterInputRefs } from '@/lib/services/chat/tools/interpreterInputRefs';

import type { ChatContext } from './ChatContext';
import {
  BASE_TURN_BUDGET,
  TurnBudget,
  TurnWorkload,
  planTurnBudget,
} from './turnBudget';

/**
 * Reads a turn's workload from its context, with the SAME predicates the
 * pipeline acts on (interpreter requested, native capability, search
 * requested, files the sandbox would mount), so the budget always covers
 * what the turn will actually try.
 *
 * @param context - The turn after request parsing (messages, modes, model).
 * @param modelTimeoutMs - The user's clamped model timeout.
 */
export function turnWorkloadFromContext(
  context: ChatContext,
  modelTimeoutMs: number,
): TurnWorkload {
  const interpreter = interpreterRequested(context);
  const native = interpreter && nativeInterpreterCapable(context);
  const documents = interpreter
    ? selectInterpreterInputRefs({
        messages: context.messages ?? [],
        activeFiles: context.activeFiles,
      }).length
    : 0;
  return {
    documents,
    subToolInterpreter: interpreter && !native,
    nativeInterpreter: native,
    webSearch: searchRequested(context),
    modelTimeoutMs,
  };
}

/**
 * The turn's budget (see turnBudget.ts), logged when it departs from the
 * compiled defaults so a long-running turn can be explained afterwards.
 */
export function planTurnBudgetFor(
  context: ChatContext,
  modelTimeoutMs: number,
): TurnBudget {
  const workload = turnWorkloadFromContext(context, modelTimeoutMs);
  const budget = planTurnBudget(workload);
  if (
    budget.toolStageMs > BASE_TURN_BUDGET.toolStageMs ||
    budget.interpreterMs > BASE_TURN_BUDGET.interpreterMs ||
    budget.modelMs > modelTimeoutMs
  ) {
    console.log(
      `[TurnBudget] ${JSON.stringify(workload)} → ${JSON.stringify(budget)}`,
    );
  }
  return budget;
}
