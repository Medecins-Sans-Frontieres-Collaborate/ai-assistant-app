import { ColumnProfile, DataColumn } from '@/types/workflow';

import {
  buildStatsBlock,
  describeColumns,
  serializeTableWithRids,
} from './prompts';
import { ROW_ID_KEY } from './tableUtils';

/**
 * Digest + prompts for the data workspace's conversation rail. The
 * digest leads with deterministic figures (client-computed column stats
 * incl. full value→count tables for low-cardinality columns) so most
 * "how many …" questions are answered exactly even when the row sample
 * is partial. Read-only by design: the workspace transform bar is the
 * single write path, so the rail never mutates the table.
 */

/** Sample rows sent to the rail digest. */
export const DIGEST_SAMPLE_ROWS = 150;

export function buildDataDigest(options: {
  columns: DataColumn[];
  stats: ColumnProfile[];
  /** Sample rows WITH their __rid values. */
  sampleRows: Record<string, unknown>[];
  totalRowCount: number;
}): string {
  const { columns, stats, sampleRows, totalRowCount } = options;
  const sampled = sampleRows.length < totalRowCount;
  return `## Table schema
${describeColumns(columns)}

## Column statistics (computed exactly over all ${totalRowCount} rows — treat as ground truth)
${buildStatsBlock(columns, stats)}

## Rows (tab-separated; first column is ${ROW_ID_KEY})${
    sampled
      ? ` — a sample of ${sampleRows.length} of the ${totalRowCount} rows`
      : ''
  }
${serializeTableWithRids(columns, sampleRows)}

Total rows: ${totalRowCount}${sampled ? ` (sample of ${sampleRows.length} shown)` : ''}`;
}

export function buildDataChatSystemPrompt(): string {
  return `You are the analysis assistant inside a data-table workspace. Answer questions about the user's table using ONLY the digest provided — never outside knowledge about what the data "should" say.

Rules:
- The column statistics and value counts were computed exactly over the FULL table: use them for totals, distributions, and "how many" questions, and present those figures as exact.
- Figures you derive from the row sample alone are estimates when the digest says the rows are a sample — say so explicitly.
- When referencing specific records, cite their ${ROW_ID_KEY} (e.g. "row 3f").
- If the digest cannot answer the question, say what's missing — do not guess.
- If the user asks you to change, clean, or add data: you cannot modify the table. Point them to the transform bar below the grid (plain-language instructions) — and NEVER claim a change was made.
- Be concise; use a small markdown table when comparing figures.`;
}

export function buildDataChatUserPrompt(
  digest: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  const history = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  return `${digest}

## Conversation
${history}

Answer the user's last message.`;
}
