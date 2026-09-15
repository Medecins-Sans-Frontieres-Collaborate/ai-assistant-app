import {
  MatchedGlossaryEntry,
  findMatchingEntries,
  resolveEntryKind,
  sortLongestFirst,
} from '@/lib/utils/shared/translation/glossaryMatch';

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
 * Rendered after the table so the model applies the entries the way the
 * deterministic checker (glossaryMatch.ts) will later verify them.
 */
export const GLOSSARY_RULES = `Rules for the terminology above:
- Apply each entry to every occurrence in the source, regardless of capitalization in the source text, including plural and inflected forms.
- Where entries overlap, the longest matching phrase wins; a shorter entry applies only outside the longer phrase. The table is ordered longest first.
- Acronym entries are case-sensitive: they apply to the short form exactly as written (e.g. "WHO"), never to an ordinary word that merely shares its letters (e.g. "who"). Use the required short form wherever the source uses the source short form; translate the full name exactly as given; keep the source's first-mention convention (full name followed by the short form in parentheses) if the source used one.
- An entry whose required translation equals its source term means: keep the term verbatim, untranslated.`;

/**
 * Renders the glossary entries that actually occur in the source text as a
 * mandatory-terminology block. Filtering keeps irrelevant entries from
 * diluting the prompt; matching is whole-word, case-insensitive for terms
 * and case-sensitive for acronyms (see glossaryMatch.ts). `charBudget`
 * (optional) drops tail rows — in ORIGINAL entry order, earlier admin rows
 * being the important ones — once the cumulative rendered size passes it.
 * The surviving rows are then rendered longest source phrase first.
 */
export function buildGlossaryBlock(
  entries: GlossaryEntry[],
  sourceText: string,
  charBudget?: number,
): string {
  const relevant = findMatchingEntries(entries, sourceText).slice(
    0,
    MAX_GLOSSARY_ENTRIES,
  );
  if (relevant.length === 0) return '';

  const rendered: { row: string; entry: GlossaryEntry }[] = [];
  let total = 0;
  for (const match of relevant) {
    const row = renderRow(match);
    if (charBudget !== undefined && total + row.length > charBudget) break;
    total += row.length;
    rendered.push({ row, entry: match.entry });
  }
  if (rendered.length === 0) return '';

  const rows = sortLongestFirst(rendered).map((r) => r.row);
  return `

MANDATORY TERMINOLOGY — translate these terms exactly as specified:

| Source term | Required translation | Note |
|---|---|---|
${rows.join('\n')}

${GLOSSARY_RULES}`;
}

function renderRow({ entry, kind }: MatchedGlossaryEntry): string {
  const notes: string[] = [];
  if (kind === 'acronym') {
    notes.push(
      `acronym, case-sensitive: applies to "${entry.source}" only, not to "${entry.source.toLowerCase()}"`,
    );
    if (entry.sourceExpansion?.trim() || entry.targetExpansion?.trim()) {
      notes.push(
        `full name: ${entry.sourceExpansion?.trim() || entry.source} → ${
          entry.targetExpansion?.trim() || entry.target
        }`,
      );
    }
  }
  if (entry.note?.trim()) notes.push(entry.note.trim());
  // Pipes inside cells would break the table the model reads.
  const cell = (s: string) => s.replace(/\|/g, '/');
  return `| ${cell(entry.source)} | ${cell(entry.target)} | ${cell(
    notes.join('; '),
  )} |`;
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
    // An acronym and an ordinary word that shares its letters ("WHO" vs
    // "who") are different entries, so acronyms dedupe on exact case.
    const key =
      resolveEntryKind(entry) === 'acronym'
        ? `acronym:${entry.source.trim()}`
        : entry.source.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}
