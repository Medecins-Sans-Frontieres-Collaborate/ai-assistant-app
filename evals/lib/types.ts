/**
 * Model-parity eval harness — shared types.
 *
 * Vocabulary:
 * - goal model:         the larger model whose answers define "good enough".
 * - aspirational model: the smaller model we are trying to bring up to goal quality.
 * - strategy:           a dynamic-system-prompt / agentic recipe applied to a model.
 * - case:               a scripted (possibly multi-turn) conversation + optional rubric.
 */
import type { SystemPromptOptions } from '@/lib/utils/app/systemPrompt';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
}

/** One raw model invocation. Every call a strategy makes is recorded. */
export interface ModelCall {
  modelId: string;
  purpose: string; // 'answer' | 'plan' | 'review' | ...
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  /** Truncated output, kept for debugging only. */
  outputPreview: string;
}

export interface CaseTurn {
  user: string;
  /** Optional per-turn rubric hint for the judge. */
  expect?: string;
}

export interface EvalCase {
  id: string;
  description?: string;
  tags?: string[];
  /** Subset of SystemPromptOptions injected into the prompt builder. */
  promptOptions?: Partial<
    Pick<
      SystemPromptOptions,
      | 'userPrompt'
      | 'webSearchActive'
      | 'codeInterpreterAvailable'
      | 'conversationSummary'
      | 'memories'
    >
  >;
  /** Global rubric for the judge ("must cite sources", "must be < 200 words", ...). */
  rubric?: string;
  turns: CaseTurn[];
}

/** What a strategy gets per turn. */
export interface StrategyContext {
  modelId: string;
  eval: EvalCase;
  turnIndex: number;
  /** Prior turns in this run (user + this run's own assistant answers). */
  history: ChatMessage[];
  /** The user message for this turn. */
  userMessage: string;
  /** Invoke the model-under-test (or another model) and have the call recorded. */
  invoke: (req: InvokeRequest) => Promise<InvokeResult>;
}

export interface InvokeRequest {
  modelId?: string; // defaults to ctx.modelId
  purpose?: string;
  systemPrompt: string;
  messages: ChatMessage[];
  temperature?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  maxTokens?: number;
}

export interface InvokeResult {
  text: string;
  usage: TokenUsage;
  latencyMs: number;
}

export interface Strategy {
  id: string;
  description: string;
  /**
   * Produce the assistant answer for one turn. Simple prompt strategies call
   * ctx.invoke once; agentic strategies may call it several times (plan →
   * answer, answer → self-review, ...). Every call's cost is attributed to
   * the strategy, which is how the cost guard catches "smarter but pricier".
   */
  respond(ctx: StrategyContext): Promise<string>;
}

export interface TurnResult {
  turnIndex: number;
  user: string;
  assistant: string;
  calls: ModelCall[];
  costUsd: number;
  latencyMs: number;
}

export interface RunResult {
  caseId: string;
  modelId: string;
  strategyId: string;
  turns: TurnResult[];
  totalCostUsd: number;
  totalLatencyMs: number;
  error?: string;
}

export interface JudgeDimensionScores {
  accuracy: number;
  completeness: number;
  formatting: number;
  concision: number;
}

export interface TurnJudgement {
  turnIndex: number;
  /** 0–10: how close the candidate is to the reference on this turn. */
  parity: number;
  dimensions: JudgeDimensionScores;
  /** 'candidate' | 'reference' | 'tie' after position-swapped pairwise vote. */
  preference: 'candidate' | 'reference' | 'tie';
  rationale: string;
}

export interface CaseComparison {
  caseId: string;
  goal: RunResult;
  candidate: RunResult;
  judgements: TurnJudgement[];
  meanParity: number;
  candidateWinRate: number; // wins + 0.5*ties over turns
  costRatio: number; // candidate cost / goal cost
  judgeCostUsd: number;
  /** True when costRatio exceeds the configured ceiling. */
  overBudget: boolean;
}

export interface StrategySummary {
  strategyId: string;
  modelId: string;
  cases: CaseComparison[];
  meanParity: number;
  meanWinRate: number;
  meanCostRatio: number;
  overBudgetCases: number;
  totalCandidateCostUsd: number;
  totalGoalCostUsd: number;
  totalJudgeCostUsd: number;
}

export interface EvalReport {
  generatedAt: string;
  goalModelId: string;
  aspirationalModelId: string;
  goalStrategyId: string;
  judgeModelId: string;
  costCeiling: number;
  strategies: StrategySummary[];
}
