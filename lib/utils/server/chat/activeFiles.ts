import { ActiveFile } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import {
  ACTIVE_FILE_PER_TURN_FRACTION,
  ACTIVE_FILE_PER_TURN_MAX,
  ACTIVE_FILE_PER_TURN_MIN,
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
 * input context window minus its reserved output. Keeps the remaining 75%
 * of input headroom for the system prompt, conversation history, and the
 * user's current message. Clamped to [MIN, MAX].
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

  const derived = Math.floor(availableForInput * ACTIVE_FILE_PER_TURN_FRACTION);
  return Math.max(
    ACTIVE_FILE_PER_TURN_MIN,
    Math.min(ACTIVE_FILE_PER_TURN_MAX, derived),
  );
}

/**
 * Simple budget selection (placeholder). Returns files unchanged.
 * Can be extended to apply token budgets and policies.
 */
export function isPinned(f: ActiveFile) {
  return !!f.pinned;
}

export function selectFilesForBudget(
  files: ActiveFile[],
  budgetTokens: number = 2000,
  policy: 'recent' | 'pinned' | 'sizeAsc' = 'recent',
): ActiveFile[] {
  // Estimation using processed tokenEstimate or fallback to rough heuristic
  const estimate = (f: ActiveFile) =>
    f.processedContent?.tokenEstimate ??
    Math.max(200, Math.floor((f.sizeBytes ?? 50_000) / 4));

  const partition = (arr: ActiveFile[], pred: (f: ActiveFile) => boolean) => {
    const a: ActiveFile[] = [];
    const b: ActiveFile[] = [];
    for (const it of arr) (pred(it) ? a : b).push(it);
    return [a, b] as const;
  };

  const [pinned, rest] = partition(files, isPinned);
  const sorters = {
    recent: (a: ActiveFile, b: ActiveFile) =>
      (b.lastUsedAt ?? b.addedAt).localeCompare(a.lastUsedAt ?? a.addedAt),
    sizeAsc: (a: ActiveFile, b: ActiveFile) => estimate(a) - estimate(b),
  } as const;

  const sorter = policy === 'sizeAsc' ? sorters.sizeAsc : sorters.recent;
  pinned.sort(sorter);
  rest.sort(sorter);

  const selected: ActiveFile[] = [];
  let used = 0;
  for (const f of [...pinned, ...rest]) {
    const est = estimate(f);
    if (used + est <= budgetTokens) {
      selected.push(f);
      used += est;
    }
  }
  if (selected.length > 0) return selected;
  return budgetTokens > 0 ? files.slice(0, 1) : [];
}

/**
 * Placeholder for image injection. Currently returns messages unchanged.
 * Images may be added to user messages for vision-capable models.
 */
export function injectActiveImages(messages: any[], _imageFiles: ActiveFile[]) {
  return messages;
}
