/**
 * LLM judge. For each turn, the goal model's answer is the *reference* and
 * the aspirational model's answer is the *candidate*. The judge:
 *   1. scores the candidate's parity with the reference (0–10) on four
 *      dimensions, given the shared conversation prefix and any rubric;
 *   2. votes pairwise twice with positions swapped to cancel position bias.
 * Judge cost is tracked separately and never attributed to a strategy.
 */
import { calculateCostUsd } from './cost';
import { invokeModel } from './invoke';
import { getModelMeta } from './models';
import type {
  EvalCase,
  JudgeDimensionScores,
  RunResult,
  TurnJudgement,
} from './types';

const JUDGE_SYSTEM = `You are a strict evaluator comparing two assistant answers to the same conversation.
Answer ONLY with compact JSON matching the requested schema. No prose, no markdown fences.`;

interface ScoreJson {
  accuracy: number;
  completeness: number;
  formatting: number;
  concision: number;
  parity: number;
  rationale: string;
}

function clamp10(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 0;
}

function parseJson<T>(text: string): T {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return JSON.parse(start >= 0 ? trimmed.slice(start, end + 1) : trimmed) as T;
}

function conversationPrefix(
  evalCase: EvalCase,
  reference: RunResult,
  turnIndex: number,
): string {
  const parts: string[] = [];
  for (let i = 0; i < turnIndex; i++) {
    parts.push(`USER: ${evalCase.turns[i].user}`);
    parts.push(`ASSISTANT: ${reference.turns[i]?.assistant ?? ''}`);
  }
  parts.push(`USER: ${evalCase.turns[turnIndex].user}`);
  return parts.join('\n\n');
}

export interface JudgeOptions {
  judgeModelId: string;
  evalCase: EvalCase;
  reference: RunResult;
  candidate: RunResult;
}

export interface JudgeOutcome {
  judgements: TurnJudgement[];
  judgeCostUsd: number;
}

export async function judgeRun({
  judgeModelId,
  evalCase,
  reference,
  candidate,
}: JudgeOptions): Promise<JudgeOutcome> {
  const meta = getModelMeta(judgeModelId);
  let judgeCostUsd = 0;
  const judgements: TurnJudgement[] = [];

  const ask = async (purpose: string, prompt: string): Promise<string> => {
    const res = await invokeModel({
      modelId: judgeModelId,
      purpose,
      systemPrompt: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 800,
    });
    judgeCostUsd += calculateCostUsd(res.usage, meta);
    return res.text;
  };

  for (let t = 0; t < candidate.turns.length; t++) {
    const refAnswer = reference.turns[t]?.assistant;
    const candAnswer = candidate.turns[t].assistant;
    if (refAnswer === undefined) break;

    const rubric = [evalCase.rubric, evalCase.turns[t].expect]
      .filter(Boolean)
      .join('\n');
    const prefix = conversationPrefix(evalCase, reference, t);

    // 1. Absolute parity scoring against the reference.
    const scoreText = await ask(
      'judge-score',
      `Conversation so far (the reference assistant's earlier turns are shown for context):
${prefix}

=== REFERENCE ANSWER (from the stronger model; treat as the quality bar) ===
${refAnswer}

=== CANDIDATE ANSWER ===
${candAnswer}
${rubric ? `\n=== RUBRIC ===\n${rubric}\n` : ''}
Score the CANDIDATE relative to the REFERENCE. 10 = indistinguishable or better, 5 = clearly worse but usable, 0 = wrong/unusable.
Return JSON: {"accuracy":0-10,"completeness":0-10,"formatting":0-10,"concision":0-10,"parity":0-10,"rationale":"one or two sentences"}`,
    );

    let scores: ScoreJson;
    try {
      scores = parseJson<ScoreJson>(scoreText);
    } catch {
      scores = {
        accuracy: 0,
        completeness: 0,
        formatting: 0,
        concision: 0,
        parity: 0,
        rationale: `unparseable judge output: ${scoreText.slice(0, 120)}`,
      };
    }

    // 2. Pairwise preference, both orders.
    const pairwise = async (
      a: string,
      b: string,
    ): Promise<'A' | 'B' | 'TIE'> => {
      const text = await ask(
        'judge-pairwise',
        `Conversation so far:
${prefix}
${rubric ? `\n=== RUBRIC ===\n${rubric}\n` : ''}
=== ANSWER A ===
${a}

=== ANSWER B ===
${b}

Which answer is better for the user? Return JSON: {"winner":"A"|"B"|"TIE"}`,
      );
      try {
        const w = String(
          parseJson<{ winner: string }>(text).winner,
        ).toUpperCase();
        return w === 'A' || w === 'B' ? w : 'TIE';
      } catch {
        return 'TIE';
      }
    };
    const first = await pairwise(candAnswer, refAnswer); // candidate = A
    const second = await pairwise(refAnswer, candAnswer); // candidate = B
    const candVotes = (first === 'A' ? 1 : 0) + (second === 'B' ? 1 : 0);
    const refVotes = (first === 'B' ? 1 : 0) + (second === 'A' ? 1 : 0);
    const preference: TurnJudgement['preference'] =
      candVotes > refVotes
        ? 'candidate'
        : refVotes > candVotes
          ? 'reference'
          : 'tie';

    const dimensions: JudgeDimensionScores = {
      accuracy: clamp10(scores.accuracy),
      completeness: clamp10(scores.completeness),
      formatting: clamp10(scores.formatting),
      concision: clamp10(scores.concision),
    };
    judgements.push({
      turnIndex: t,
      parity: clamp10(scores.parity),
      dimensions,
      preference,
      rationale: String(scores.rationale ?? ''),
    });
  }

  return { judgements, judgeCostUsd };
}
