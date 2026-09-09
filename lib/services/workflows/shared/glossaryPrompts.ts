import { GlossaryEntry } from '@/types/workflow';

/**
 * Mandatory-terminology prompt block, shared by the translation workflow
 * (local glossaries) and admin terminology guides (both workflows). Moved
 * here from translation/prompts.ts unchanged so guides and glossaries render
 * through one code path.
 */

/** Caps to keep the glossary block inside a sane prompt budget. */
export const MAX_GLOSSARY_ENTRIES = 200;

/**
 * Cumulative character budget for a terminology-GUIDE block (≈4k tokens,
 * matching GUIDE_TOKEN_BUDGET for body guides). Rows past the budget are
 * dropped from the TAIL — earlier entries are assumed more important, and
 * truncating mid-table would corrupt the markdown.
 */
export const GUIDE_GLOSSARY_BLOCK_CHAR_BUDGET = 16_000;

/**
 * Renders the glossary entries that actually occur in the source text as a
 * mandatory-terminology block. Filtering keeps irrelevant entries from
 * diluting the prompt; matching is case-insensitive whole-string contains.
 * `charBudget` (optional) additionally drops tail rows once the cumulative
 * rendered size passes it.
 */
export function buildGlossaryBlock(
  entries: GlossaryEntry[],
  sourceText: string,
  charBudget?: number,
): string {
  const haystack = sourceText.toLowerCase();
  const relevant = entries
    .filter((e) => e.source && e.target)
    .filter((e) => haystack.includes(e.source.toLowerCase()))
    .slice(0, MAX_GLOSSARY_ENTRIES);
  if (relevant.length === 0) return '';

  const rowStrings: string[] = [];
  let total = 0;
  for (const e of relevant) {
    const row = `| ${e.source} | ${e.target} |${e.note ? ` ${e.note} |` : ' |'}`;
    if (charBudget !== undefined && total + row.length > charBudget) break;
    total += row.length;
    rowStrings.push(row);
  }
  if (rowStrings.length === 0) return '';

  return `

MANDATORY TERMINOLOGY — translate these terms exactly as specified:

| Source term | Required translation | Note |
|---|---|---|
${rowStrings.join('\n')}`;
}

/**
 * Merges admin terminology-guide entries with a user's local glossary
 * entries. Admin entries come FIRST and WIN on a case-insensitive duplicate
 * source term — organization-mandated terminology is authoritative over
 * personal glossaries.
 */
export function mergeGlossaryEntries(
  guideEntries: GlossaryEntry[],
  localEntries: GlossaryEntry[],
): GlossaryEntry[] {
  const seen = new Set<string>();
  const merged: GlossaryEntry[] = [];
  for (const entry of [...guideEntries, ...localEntries]) {
    if (!entry.source) continue;
    const key = entry.source.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}
