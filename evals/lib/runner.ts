/**
 * Runs one case through one model with one strategy, turn by turn.
 * Each turn's assistant answer is the strategy's own output — so a weak
 * answer on turn 1 degrades the context for turn 2 exactly as it would in
 * the app, which is what makes multi-turn cases meaningful.
 */
import { calculateCostUsd } from './cost';
import { invokeModel } from './invoke';
import { getModelMeta } from './models';
import type {
  ChatMessage,
  EvalCase,
  InvokeRequest,
  ModelCall,
  RunResult,
  Strategy,
  TurnResult,
} from './types';

export interface RunOptions {
  evalCase: EvalCase;
  modelId: string;
  strategy: Strategy;
  log?: (line: string) => void;
}

export async function runCase({
  evalCase,
  modelId,
  strategy,
  log,
}: RunOptions): Promise<RunResult> {
  const history: ChatMessage[] = [];
  const turns: TurnResult[] = [];
  const result: RunResult = {
    caseId: evalCase.id,
    modelId,
    strategyId: strategy.id,
    turns,
    totalCostUsd: 0,
    totalLatencyMs: 0,
  };

  for (let turnIndex = 0; turnIndex < evalCase.turns.length; turnIndex++) {
    const turn = evalCase.turns[turnIndex];
    const calls: ModelCall[] = [];
    const started = Date.now();

    const invoke = async (req: InvokeRequest) => {
      const targetModel = req.modelId ?? modelId;
      const res = await invokeModel({ ...req, modelId: targetModel });
      calls.push({
        modelId: targetModel,
        purpose: req.purpose ?? 'answer',
        usage: res.usage,
        costUsd: calculateCostUsd(res.usage, getModelMeta(targetModel)),
        latencyMs: res.latencyMs,
        outputPreview: res.text.slice(0, 160),
      });
      return res;
    };

    try {
      const assistant = await strategy.respond({
        modelId,
        eval: evalCase,
        turnIndex,
        history: [...history],
        userMessage: turn.user,
        invoke,
      });
      const turnResult: TurnResult = {
        turnIndex,
        user: turn.user,
        assistant,
        calls,
        costUsd: calls.reduce((s, c) => s + c.costUsd, 0),
        latencyMs: Date.now() - started,
      };
      turns.push(turnResult);
      result.totalCostUsd += turnResult.costUsd;
      result.totalLatencyMs += turnResult.latencyMs;
      history.push(
        { role: 'user', content: turn.user },
        { role: 'assistant', content: assistant },
      );
      log?.(
        `  [${modelId}/${strategy.id}] ${evalCase.id} turn ${turnIndex + 1}/${evalCase.turns.length} — ${calls.length} call(s), $${turnResult.costUsd.toFixed(5)}, ${turnResult.latencyMs}ms`,
      );
    } catch (error) {
      result.error = `turn ${turnIndex + 1}: ${error instanceof Error ? error.message : String(error)}`;
      log?.(
        `  [${modelId}/${strategy.id}] ${evalCase.id} FAILED: ${result.error}`,
      );
      break;
    }
  }
  return result;
}
