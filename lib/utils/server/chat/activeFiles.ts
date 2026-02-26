import { ActiveFile } from '@/types/chat';

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
 * Simple budget selection (placeholder). Returns files unchanged.
 * Can be extended to apply token budgets and policies.
 */
export function selectFilesForBudget(
  files: ActiveFile[],
  _budgetTokens?: number,
  _policy?: 'recent' | 'pinned' | 'sizeAsc',
): ActiveFile[] {
  return files;
}

/**
 * Placeholder for image injection. Currently returns messages unchanged.
 * Images may be added to user messages for vision-capable models.
 */
export function injectActiveImages(messages: any[], _imageFiles: ActiveFile[]) {
  return messages;
}
