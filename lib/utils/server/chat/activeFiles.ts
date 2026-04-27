import { ActiveFile } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import {
  ACTIVE_FILE_PER_TURN_MAX,
  ACTIVE_FILE_PER_TURN_MIN,
  getActiveFileBudgets,
} from '@/lib/constants/activeFileQuotas';

/**
 * Build a deterministic, injection-ready text block from active files.
 * Dedupe by id and order by lastUsedAt/addedAt (most recent first).
 */
export function buildActiveFileTextBlock(
  files: ActiveFile[],
  opts?: {
    redactFilenames?: boolean;
  },
): string {
  if (!files || files.length === 0) return '';

  const dedupedMap = new Map<string, ActiveFile>();
  for (const f of files) {
    if (!dedupedMap.has(f.id)) dedupedMap.set(f.id, f);
  }
  const deduped = Array.from(dedupedMap.values());

  deduped.sort((a, b) =>
    (b.lastUsedAt ?? b.addedAt).localeCompare(a.lastUsedAt ?? a.addedAt),
  );

  const lines: string[] = [];
  lines.push('[[Active Files Context]]');

  let index = 1;
  for (const f of deduped) {
    const label = opts?.redactFilenames
      ? `document-${index++}`
      : f.originalFilename || f.id;

    if (f.processedContent && f.processedContent.type !== 'image') {
      const header = `[${label}]`;
      const body = f.processedContent.summary || f.processedContent.content;
      lines.push(`${header}\n${body}`);
    } else {
      // If not processed yet, include a placeholder reference
      lines.push(`[${label}] (content processing pending)`);
    }
  }

  return lines.join('\n\n');
}

/**
 * Per-turn token budget for active-file injection, derived from the model's
 * input context window minus its reserved output. The fraction and ceiling
 * are tiered by model context window via `getActiveFileBudgets`. Clamped to
 * [ACTIVE_FILE_PER_TURN_MIN, ACTIVE_FILE_PER_TURN_MAX].
 */
export function computeActiveFilePerTurnBudget(
  model: Pick<OpenAIModel, 'maxLength' | 'tokenLimit'> | undefined | null,
): number {
  const maxLength = model?.maxLength ?? 0;
  const tokenLimit = model?.tokenLimit ?? 0;
  const availableForInput = maxLength - tokenLimit;

  if (availableForInput <= 0) {
    return ACTIVE_FILE_PER_TURN_MIN;
  }

  const { fraction, perTurnCap } = getActiveFileBudgets(model);
  const derived = Math.floor(availableForInput * fraction);
  return Math.max(
    ACTIVE_FILE_PER_TURN_MIN,
    Math.min(ACTIVE_FILE_PER_TURN_MAX, perTurnCap, derived),
  );
}

export function isPinned(f: ActiveFile) {
  return !!f.pinned;
}

const estimateTokens = (f: ActiveFile) =>
  f.processedContent?.tokenEstimate ??
  Math.max(200, Math.floor((f.sizeBytes ?? 50_000) / 4));

type SelectionPolicy = 'recent' | 'sizeAsc';

const SORTERS: Record<
  SelectionPolicy,
  (a: ActiveFile, b: ActiveFile) => number
> = {
  recent: (a, b) =>
    (b.lastUsedAt ?? b.addedAt).localeCompare(a.lastUsedAt ?? a.addedAt),
  sizeAsc: (a, b) => estimateTokens(a) - estimateTokens(b),
};

function greedySelect(
  files: ActiveFile[],
  budgetTokens: number,
  policy: SelectionPolicy,
): { selected: ActiveFile[]; dropped: ActiveFile[] } {
  const partition = (arr: ActiveFile[], pred: (f: ActiveFile) => boolean) => {
    const a: ActiveFile[] = [];
    const b: ActiveFile[] = [];
    for (const it of arr) (pred(it) ? a : b).push(it);
    return [a, b] as const;
  };

  const [pinned, rest] = partition(files, isPinned);
  // Pinned files always sort by recency so the most-recently-used pinned
  // file wins when pin tonnage alone exceeds budget; only the unpinned
  // tier varies by the fairness policy.
  pinned.sort(SORTERS.recent);
  rest.sort(SORTERS[policy]);

  const selected: ActiveFile[] = [];
  const dropped: ActiveFile[] = [];
  let used = 0;
  for (const f of [...pinned, ...rest]) {
    const est = estimateTokens(f);
    if (used + est <= budgetTokens) {
      selected.push(f);
      used += est;
    } else {
      dropped.push(f);
    }
  }
  return { selected, dropped };
}

/**
 * Fairness-aware budget selection. Returns the files that fit within
 * `budgetTokens` and the files that were dropped so callers can surface
 * the exclusion to the user.
 *
 * Strategy: try greedy by `recent` first. If anything was dropped, retry
 * with `sizeAsc` (smallest-first) to see if more files can fit. Pick
 * whichever variant included more files — preferring `sizeAsc` on ties so
 * smaller files don't get starved by a single large recent upload.
 *
 * If nothing fits at all (every file is bigger than the budget), fall
 * back to including the single smallest file so the user gets *something*
 * rather than a silent total-exclusion.
 */
export function selectFilesForBudget(
  files: ActiveFile[],
  budgetTokens: number,
): { selected: ActiveFile[]; dropped: ActiveFile[] } {
  if (files.length === 0 || budgetTokens <= 0) {
    return { selected: [], dropped: files.slice() };
  }

  const recentResult = greedySelect(files, budgetTokens, 'recent');
  if (recentResult.dropped.length === 0) return recentResult;

  const sizeAscResult = greedySelect(files, budgetTokens, 'sizeAsc');
  const winner =
    sizeAscResult.selected.length >= recentResult.selected.length
      ? sizeAscResult
      : recentResult;

  if (winner.selected.length > 0) return winner;

  // Nothing fit: include the single smallest file as a degraded fallback
  // so the user is not left with zero context.
  const sorted = files.slice().sort(SORTERS.sizeAsc);
  const [smallest, ...rest] = sorted;
  return { selected: [smallest], dropped: rest };
}

/**
 * Placeholder for image injection. Currently returns messages unchanged.
 * Images may be added to user messages for vision-capable models.
 */
export function injectActiveImages(messages: any[], _imageFiles: ActiveFile[]) {
  return messages;
}
