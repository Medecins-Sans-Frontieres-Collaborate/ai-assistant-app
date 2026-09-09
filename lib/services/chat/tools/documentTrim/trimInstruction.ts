import type { TrimmableFormat } from './trimDetector';

/**
 * Deterministic Stage-2 sandbox instruction. Only the interpolated values
 * below come from code — no model-authored prose ever reaches this string,
 * so the executor's contract cannot be renegotiated by a planning model.
 */

export interface TrimInstructionParams {
  filename: string;
  outputFilename: string;
  format: TrimmableFormat;
  unit: 'words' | 'characters';
  target: number;
}

const DOCX_APPLY_STEPS = `2. Open the .docx with python-docx. Operate ONLY on doc.paragraphs (body
   paragraphs, in document order — this excludes tables, headers, and
   footers; never modify those).
3. Apply a matched operation to \`paragraphCount\` consecutive body paragraphs:
   - delete  -> for each paragraph p: p._element.getparent().remove(p._element)
   - replace -> clear the FIRST paragraph's runs and set its text to
     replacement[0] (keep the paragraph's style); insert any further
     replacement strings as new paragraphs directly after it with the same
     style; then delete the remaining paragraphs of the span.`;

const TEXT_APPLY_STEPS = `2. Read the file as UTF-8 text. Split into paragraphs on blank lines
   (consecutive newlines); a "paragraph" is one such block, in order.
3. Apply a matched operation to \`paragraphCount\` consecutive paragraphs:
   - delete  -> drop those blocks.
   - replace -> substitute the span with the replacement strings, one block
     each, preserving blank-line separation.
   Rejoin blocks with blank lines and keep all untouched blocks byte-identical.`;

export function buildTrimInstruction(params: TrimInstructionParams): string {
  const { filename, outputFilename, format, unit, target } = params;
  const applySteps = format === 'docx' ? DOCX_APPLY_STEPS : TEXT_APPLY_STEPS;

  return `Execute the precomputed edit plan in plan.json against ${filename}. You make
NO editorial decisions — apply the plan mechanically with Python.

1. Load plan.json (fields: operations[{action, anchor, paragraphCount,
   replacement}], summary, excludedSectionHeadings). Excluded sections are
   LOCKED: a locked region starts at a paragraph whose normalized text
   equals (or starts with) one of excludedSectionHeadings and runs until
   the next heading paragraph (docx: a paragraph whose style name starts
   with "Heading"; md/txt: a line starting with "#") or the end of the
   document. Locked paragraphs must NEVER be modified or deleted, and are
   EXCLUDED from all word/character counts below.
${applySteps}
4. Matching: define normalize(s) = collapse all whitespace runs to single
   spaces, map curly quotes and en/em dashes to their ASCII equivalents,
   strip. Process operations IN ORDER, scanning forward from the previously
   matched paragraph index only. A paragraph matches an operation when
   normalize(paragraph text).startswith(normalize(anchor)). If no exact
   match exists in the next 300 paragraphs, take the best
   difflib.SequenceMatcher ratio >= 0.85 between normalize(anchor) and the
   equal-length prefix of normalize(paragraph text). If still no match,
   count the operation as unmatched and continue — never guess or apply it
   elsewhere.
5. Save the result as "${outputFilename}".
6. Compute counts identically before and after over the same paragraph set,
   SKIPPING locked paragraphs: words = sum of len(text.split()) per counted
   paragraph; characters = sum of len(text) per counted paragraph. Also sum
   the words of locked paragraphs as words_excluded. The requested target
   is ${target} ${unit} (locked sections do not count toward it).
   Print EXACTLY one line:
   TRIM_STATS: {"words_before": <int>, "words_after": <int>, "chars_before": <int>, "chars_after": <int>, "words_excluded": <int>, "ops_total": <int>, "ops_applied": <int>, "ops_unmatched": <int>}
7. In your final answer, cite/attach the saved "${outputFilename}" so it is
   downloadable, and state the before/after ${unit} counts. Do not paste the
   document's content into the chat.`;
}
