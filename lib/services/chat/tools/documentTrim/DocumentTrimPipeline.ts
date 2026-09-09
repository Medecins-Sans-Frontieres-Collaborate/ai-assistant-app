import { Session } from 'next-auth';

import { estimateTokens } from '@/lib/services/workflows/shared/textBudget';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import {
  CodeInterpreterInputFile,
  CodeInterpreterResult,
  CodeInterpreterTool,
  ContainerFileCitationRef,
  createFoundryOpenAIClient,
} from '../CodeInterpreterTool';
import { persistContainerFiles } from '../CodeInterpreterTool';
import { TrimTarget, TrimmableFormat } from './trimDetector';
import { buildTrimInstruction } from './trimInstruction';
import { TRIM_PLAN_SCHEMA, TrimPlan } from './trimPlanSchema';
import { partitionForTrim } from './trimSections';

/**
 * Deterministic two-stage document length transformation.
 *
 * Stage 1 (PLAN): a structured LLM call decides what to cut/condense,
 * producing a mechanical edit plan (delete/replace operations anchored to
 * verbatim paragraph openings).
 *
 * Stage 2 (EXECUTE): the code-interpreter sandbox applies the plan to the
 * ORIGINAL file bytes with a fixed, non-negotiable instruction, saves the
 * output in the input's format, and prints verifiable TRIM_STATS.
 *
 * Verification: stats are parsed and checked against the target; one
 * corrective re-plan is allowed, always re-executed from the original bytes
 * so drift cannot compound. The pipeline never fabricates results — if no
 * output file can be recovered, it throws (honest failure).
 */

export interface DocumentTrimParams {
  /** Original bytes — every execution starts from these. */
  document: CodeInterpreterInputFile;
  format: TrimmableFormat;
  /** Extracted text (pandoc markdown for docx) — planning input only. */
  extractedText: string;
  target: TrimTarget;
  session: Session;
  interpreterTool: CodeInterpreterTool;
  /** Wall-clock budget for the whole pipeline. */
  budgetMs?: number;
  onActivity?: (key: string, params?: Record<string, string>) => void;
}

export interface DocumentTrimResult extends CodeInterpreterResult {
  unit: 'words' | 'characters';
  targetCount: number;
  /** Counts of the COUNTABLE body only — excluded sections don't figure. */
  countBefore: number | null;
  countAfter: number | null;
  retried: boolean;
  /** Protected sections excluded from the count and left untouched. */
  excludedSections: string[];
}

interface TrimStats {
  words_before: number;
  words_after: number;
  chars_before: number;
  chars_after: number;
  /** Locked (excluded-section) words — reported for transparency only. */
  words_excluded?: number;
  ops_total: number;
  ops_applied: number;
  ops_unmatched: number;
}

const DEFAULT_BUDGET_MS = 170_000;
/**
 * Minimum remaining budget to attempt the corrective second pass. A retry
 * is a full re-plan plus a sandbox run — starting one that cannot finish
 * used to blow the stage timeout and destroy a perfectly usable first-pass
 * file, which is strictly worse than shipping that file with an honest
 * count.
 */
const RETRY_MIN_BUDGET_MS = 150_000;
/** Safety margin kept between the retry race and the caller's own timeout. */
const RETRY_DEADLINE_MARGIN_MS = 10_000;
/** Structured plans carry rewritten prose — needs far more than defaults. */
const PLAN_MAX_TOKENS = 16_000;
/** Planning chunk budget in tokens (converted to chars at ~4 chars/token). */
const PLAN_CHUNK_TOKENS = 8_000;
/** Acceptance band: overshoot beyond +10% or undershoot below −25% retries. */
const OVERSHOOT_RATIO = 1.1;
const UNDERSHOOT_RATIO = 0.75;
/** More than 20% unmatched operations means matching failed materially. */
const MAX_UNMATCHED_RATIO = 0.2;

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Resolves a ratio target to an absolute count using the extracted text. */
export function resolveTrimTarget(
  target: TrimTarget,
  extractedText: string,
): { unit: 'words' | 'characters'; target: number; approx: boolean } {
  if (target.kind === 'absolute') {
    return { unit: target.unit, target: target.target, approx: target.approx };
  }
  return {
    unit: 'words',
    target: Math.max(1, Math.round(countWords(extractedText) * target.keep)),
    approx: true,
  };
}

const PLANNER_SYSTEM_PROMPT = `You are producing a MECHANICAL edit plan to shorten a document. Another program will apply your plan verbatim — you will not get to clarify anything.

Rules:
- anchor: copy the EXACT opening text (at least 40 characters where the paragraph allows) of the FIRST paragraph of each affected span, character-for-character from the source. Anchors must be unique within the document, and operations must be listed in document order.
- Never target headings, tables, captions, or reference-list entries.
- Prefer whole-paragraph DELETIONS of redundant or peripheral material over rewrites. Use "replace" only where a deletion would break coherence, and keep replacements substantially shorter than the span they replace.
- Aim the total surviving length at the stated target. The result is verified mechanically and your plan is re-run if it misses.`;

/**
 * Splits planning input into chunks that fit the planner's context. Splits
 * on markdown headings first, blank-line groups as fallback; groups are
 * greedily packed by a character budget (~4 chars/token — cheap and
 * deterministic; `estimateTokens` is used only for the single-chunk check).
 */
export async function chunkForPlanning(text: string): Promise<string[]> {
  if ((await estimateTokens(text)) <= PLAN_CHUNK_TOKENS) return [text];

  const charBudget = PLAN_CHUNK_TOKENS * 4;
  const sections = text
    .split(/\n(?=#{1,6}\s)/)
    .flatMap((section) =>
      section.length > charBudget ? section.split(/\n\s*\n/) : [section],
    );

  const chunks: string[] = [];
  let current = '';
  for (const section of sections) {
    if (current && current.length + section.length > charBudget) {
      chunks.push(current);
      current = section;
    } else {
      current = current ? `${current}\n${section}` : section;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function buildTrimPlan(options: {
  extractedText: string;
  unit: 'words' | 'characters';
  target: number;
  feedback?: string;
}): Promise<TrimPlan> {
  const { extractedText, unit, target, feedback } = options;
  const client = createAzureClient();
  const model = resolveWorkflowModelId();

  const measure = unit === 'words' ? countWords : (t: string) => t.length;
  const total = measure(extractedText);
  const chunks = await chunkForPlanning(extractedText);

  // Chunks plan IN PARALLEL — sections are independent (per-chunk budgets
  // are computed here, not by the model) and sequential planning cost 2-3×
  // the wall clock, which is what starved the corrective pass of budget.
  // Document order is preserved by concatenating results by chunk index.
  const chunkPlans = await Promise.all(
    chunks.map((chunk, index) => {
      const chunkSize = measure(chunk);
      // Deterministic per-chunk budget: every section shrinks by the same
      // ratio, so the totals add up to the target without model arithmetic.
      const chunkTarget = Math.max(1, Math.round((chunkSize * target) / total));

      const user =
        `Document section ${index + 1}/${chunks.length} (currently ~${chunkSize} ${unit}). ` +
        `Reduce this section to approximately ${chunkTarget} ${unit}.\n` +
        (feedback ? `${feedback}\n` : '') +
        `\n--- SECTION START ---\n${chunk}\n--- SECTION END ---`;

      return callStructured<TrimPlan>({
        client,
        system: PLANNER_SYSTEM_PROMPT,
        user,
        schemaName: 'trim_plan',
        schema: TRIM_PLAN_SCHEMA,
        model,
        maxTokens: PLAN_MAX_TOKENS,
      });
    }),
  );

  const operations = chunkPlans.flatMap((plan) => plan.operations);
  const summaries = chunkPlans
    .map((plan) => plan.summary)
    .filter(Boolean) as string[];

  if (operations.length === 0) {
    throw new Error('Trim planning produced no operations');
  }
  return { operations, summary: summaries.join(' ') };
}

/** Parses the executor's mandatory TRIM_STATS line (last occurrence wins). */
export function parseTrimStats(
  result: CodeInterpreterResult,
): TrimStats | null {
  const haystacks = [
    ...result.codeRuns.map((run) => run.logs ?? ''),
    result.text,
  ];
  let stats: TrimStats | null = null;
  for (const haystack of haystacks) {
    const matches = haystack.matchAll(/TRIM_STATS:\s*(\{[^\n]*\})/g);
    for (const match of matches) {
      try {
        const parsed = JSON.parse(match[1]) as Partial<TrimStats>;
        if (
          typeof parsed.words_after === 'number' &&
          typeof parsed.ops_total === 'number'
        ) {
          stats = parsed as TrimStats;
        }
      } catch {
        // Malformed line — keep scanning.
      }
    }
  }
  return stats;
}

function outputFilenameFor(
  document: CodeInterpreterInputFile,
  format: TrimmableFormat,
  unit: 'words' | 'characters',
  target: number,
): string {
  const stem = document.filename.replace(/\.[^.]+$/, '');
  const extension =
    format === 'docx' ? 'docx' : (document.filename.split('.').pop() ?? format);
  return `${stem}_trimmed_${target}${unit}.${extension}`;
}

function findOutputFile(
  result: CodeInterpreterResult,
  outputFilename: string,
): CodeInterpreterResult['generatedFiles'][number] | null {
  const extension = outputFilename.split('.').pop()?.toLowerCase();
  return (
    result.generatedFiles.find((f) => f.filename === outputFilename) ??
    result.generatedFiles.find(
      (f) =>
        f.filename.includes('_trimmed_') &&
        f.filename.toLowerCase().endsWith(`.${extension}`),
    ) ??
    result.generatedFiles.find(
      (f) => !f.is_image && f.filename.toLowerCase().endsWith(`.${extension}`),
    ) ??
    null
  );
}

/**
 * The sandbox model sometimes saves the file but fails to cite it (the
 * hallucination-adjacent failure this pipeline exists to kill). Recover it
 * by listing the container's files directly. Containers expire ~30 min
 * idle, so this runs immediately after the execution.
 */
async function recoverUncitedOutput(
  result: CodeInterpreterResult,
  outputFilename: string,
  session: Session,
): Promise<CodeInterpreterResult['generatedFiles']> {
  if (result.containerIds.length === 0) return [];
  const extension = outputFilename.split('.').pop()?.toLowerCase();
  try {
    const client = await createFoundryOpenAIClient();
    const citations: ContainerFileCitationRef[] = [];
    for (const containerId of result.containerIds) {
      const page = await client.containers.files.list(containerId);
      for await (const file of page) {
        const path = (file as { path?: string }).path ?? '';
        const filename = path.split('/').pop() ?? '';
        if (
          filename.toLowerCase().endsWith(`.${extension}`) &&
          (filename === outputFilename || filename.includes('_trimmed_'))
        ) {
          citations.push({ containerId, fileId: file.id, filename });
        }
      }
    }
    if (citations.length === 0) return [];
    return await persistContainerFiles(client, citations, session);
  } catch (error) {
    console.warn(
      '[DocumentTrim] Container recovery failed:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

interface AttemptOutcome {
  result: CodeInterpreterResult;
  stats: TrimStats | null;
  outputFile: CodeInterpreterResult['generatedFiles'][number] | null;
  actual: number | null;
}

async function executeAttempt(options: {
  params: DocumentTrimParams;
  plan: TrimPlan;
  unit: 'words' | 'characters';
  target: number;
  outputFilename: string;
  excludedHeadings: string[];
}): Promise<AttemptOutcome> {
  const { params, plan, unit, target, outputFilename, excludedHeadings } =
    options;

  const instruction = buildTrimInstruction({
    filename: params.document.filename,
    outputFilename,
    format: params.format,
    unit,
    target,
  });

  const result = await params.interpreterTool.execute({
    task: instruction,
    session: params.session,
    verbatimTask: true,
    inputFiles: [
      params.document,
      {
        filename: 'plan.json',
        data: Buffer.from(
          JSON.stringify({
            ...plan,
            // Sections locked against edits and excluded from counts —
            // travels beside the plan, never through a model prompt.
            excludedSectionHeadings: excludedHeadings,
          }),
          'utf-8',
        ),
        mimeType: 'application/json',
      },
    ],
  });

  let outputFile = findOutputFile(result, outputFilename);
  if (!outputFile) {
    const recovered = await recoverUncitedOutput(
      result,
      outputFilename,
      params.session,
    );
    if (recovered.length > 0) {
      result.generatedFiles = [...result.generatedFiles, ...recovered];
      outputFile = findOutputFile(result, outputFilename);
    }
  }

  const stats = parseTrimStats(result);
  const actual = stats
    ? unit === 'words'
      ? stats.words_after
      : stats.chars_after
    : null;
  return { result, stats, outputFile, actual };
}

function needsRetry(
  outcome: AttemptOutcome,
  target: number,
): { retry: boolean; reason: string | null } {
  if (!outcome.outputFile) return { retry: true, reason: 'no output file' };
  if (!outcome.stats) return { retry: true, reason: 'no TRIM_STATS' };
  const { ops_total, ops_unmatched } = outcome.stats;
  if (ops_total > 0 && ops_unmatched / ops_total > MAX_UNMATCHED_RATIO) {
    return {
      retry: true,
      reason: `${ops_unmatched}/${ops_total} ops unmatched`,
    };
  }
  if (outcome.actual != null && outcome.actual > target * OVERSHOOT_RATIO) {
    return { retry: true, reason: `overshoot: ${outcome.actual} > target` };
  }
  if (outcome.actual != null && outcome.actual < target * UNDERSHOOT_RATIO) {
    return { retry: true, reason: `undershoot: ${outcome.actual} < target` };
  }
  return { retry: false, reason: null };
}

export async function runDocumentTrim(
  params: DocumentTrimParams,
): Promise<DocumentTrimResult> {
  const startedAt = Date.now();
  const budgetMs = params.budgetMs ?? DEFAULT_BUDGET_MS;

  // Back-matter (References, appendices, declarations…) is excluded from
  // the target arithmetic, never shown to the planner, and locked against
  // edits in the executor contract. "Trim to 6k words" means 6k words of
  // BODY — cutting the reference list to hit a number would be vandalism.
  const partition = partitionForTrim(params.extractedText);
  const resolved = resolveTrimTarget(params.target, partition.countableText);
  const outputFilename = outputFilenameFor(
    params.document,
    params.format,
    resolved.unit,
    resolved.target,
  );
  if (partition.excludedHeadings.length > 0) {
    console.log(
      `[DocumentTrim] Excluding ${partition.excludedHeadings.length} protected section(s) from count and edits: ${partition.excludedHeadings.join(', ')} (~${partition.excludedWordCount} words)`,
    );
  }

  params.onActivity?.('chat.activity.trimPlanning', {
    target: String(resolved.target),
    unit: resolved.unit,
  });
  const plan = await buildTrimPlan({
    extractedText: partition.countableText,
    unit: resolved.unit,
    target: resolved.target,
  });

  params.onActivity?.('chat.activity.trimApplying');
  let outcome = await executeAttempt({
    params,
    plan,
    unit: resolved.unit,
    target: resolved.target,
    outputFilename,
    excludedHeadings: partition.excludedHeadings,
  });

  params.onActivity?.('chat.activity.trimVerifying');
  const verdict = needsRetry(outcome, resolved.target);
  let retried = false;
  let activePlan = plan;

  if (
    verdict.retry &&
    Date.now() - startedAt < budgetMs - RETRY_MIN_BUDGET_MS
  ) {
    console.warn(
      `[DocumentTrim] First pass needs retry (${verdict.reason}); re-planning from the original document`,
    );
    params.onActivity?.('chat.activity.trimRetrying', {
      actual: String(outcome.actual ?? 'unknown'),
    });
    retried = true;

    const feedback = outcome.actual
      ? `A previous plan achieved ${outcome.actual} ${resolved.unit} against the ${resolved.target} ${resolved.unit} target. Produce a complete revised plan that ${
          outcome.actual > resolved.target
            ? 'cuts more aggressively (prefer more deletions)'
            : 'cuts less aggressively (restore some material)'
        }.`
      : `A previous plan could not be applied reliably (${verdict.reason}). Produce a complete revised plan with simpler, longer verbatim anchors and prefer whole-paragraph deletions.`;

    try {
      // The ENTIRE corrective pass races the remaining budget (minus a
      // margin below the caller's own timeout): a slow retry must degrade
      // to shipping the first pass, never take the whole turn down with it.
      const remainingMs =
        budgetMs - (Date.now() - startedAt) - RETRY_DEADLINE_MARGIN_MS;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const correctivePass = async () => {
        const secondPlan = await buildTrimPlan({
          extractedText: partition.countableText,
          unit: resolved.unit,
          target: resolved.target,
          feedback,
        });
        params.onActivity?.('chat.activity.trimApplying');
        // Always re-execute from the ORIGINAL bytes — never chain outputs.
        const second = await executeAttempt({
          params,
          plan: secondPlan,
          unit: resolved.unit,
          target: resolved.target,
          outputFilename,
          excludedHeadings: partition.excludedHeadings,
        });
        return { second, secondPlan };
      };
      const { second, secondPlan } = await Promise.race([
        correctivePass(),
        new Promise<never>((_, reject) => {
          retryTimer = setTimeout(
            () => {
              reject(new Error('corrective pass out of budget'));
            },
            Math.max(1, remainingMs),
          );
        }),
      ]).finally(() => {
        if (retryTimer) clearTimeout(retryTimer);
      });
      // Keep whichever attempt has a file and lands closer to the target.
      const distance = (o: AttemptOutcome) =>
        o.outputFile && o.actual != null
          ? Math.abs(o.actual - resolved.target)
          : Number.POSITIVE_INFINITY;
      if (
        (second.outputFile && !outcome.outputFile) ||
        distance(second) <= distance(outcome)
      ) {
        outcome = second;
        activePlan = secondPlan;
      }
    } catch (error) {
      console.warn(
        '[DocumentTrim] Corrective pass failed; keeping first result:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (!outcome.outputFile) {
    // Honest failure: no phantom download cards, ever.
    throw new Error(
      `Document trim produced no output file (${verdict.reason ?? 'unknown'})`,
    );
  }

  const countBefore = outcome.stats
    ? resolved.unit === 'words'
      ? outcome.stats.words_before
      : outcome.stats.chars_before
    : null;
  const countAfter = outcome.actual;
  const missedTarget =
    countAfter != null &&
    (countAfter > resolved.target * OVERSHOOT_RATIO ||
      countAfter < resolved.target * UNDERSHOOT_RATIO);

  console.log(
    `[DocumentTrim] Done: ${sanitizeForLog(params.document.filename)} ${countBefore ?? '?'} → ${countAfter ?? '?'} ${resolved.unit} (target ${resolved.target}, retried: ${retried})`,
  );

  const exclusionNote =
    partition.excludedHeadings.length > 0
      ? ` Protected sections excluded from the count and left untouched: ${partition.excludedHeadings.join(', ')}.`
      : '';
  const text =
    `Document trimmed: ${params.document.filename} (${countBefore ?? 'unknown'} ${resolved.unit}) → ` +
    `${outcome.outputFile.filename} (${countAfter ?? 'unknown'} ${resolved.unit}); target ${resolved.target} ${resolved.unit}` +
    (missedTarget
      ? ` — NOTE: the result missed the target; report the actual count honestly.`
      : '.') +
    exclusionNote +
    (activePlan.summary ? ` ${activePlan.summary}` : '');

  return {
    ...outcome.result,
    text,
    unit: resolved.unit,
    targetCount: resolved.target,
    countBefore,
    countAfter,
    retried,
    excludedSections: partition.excludedHeadings,
  };
}
