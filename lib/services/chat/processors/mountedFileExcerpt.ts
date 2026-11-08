/**
 * Excerpts for documents the code interpreter can read in full.
 *
 * On a native interpreter turn, every model call of the turn re-sends the
 * whole context, so a large document inlined in the prompt is paid for
 * several times against the deployment's per-minute limit — and summarizing
 * it instead spends that same deployment's throughput on map-reduce calls
 * and hands the model a lossy digest of data it could read exactly. When
 * the document is also mounted in the sandbox, the prompt only needs enough
 * of it to orient: its structure and opening rows, plus where the full copy
 * is. The model reads everything else with code.
 */

/**
 * Most tokens of mounted documents inlined IN FULL per interpreter turn.
 * Anything beyond is excerpted. The model reads mounted files exactly with
 * code, and each inline copy is re-sent on every model call of the turn, so
 * a full-window inline budget is the wrong one here: on 2026-11-07 two
 * spreadsheets (~70K tokens) still fit Luna's per-call window and the turn
 * was rate-limited on its third call. Small files (a short CSV, a memo)
 * stay inline so simple questions need no code.
 */
export const MOUNTED_FILES_INLINE_BUDGET_TOKENS = 16_000;

/** Token size of the excerpt when the turn's inline budget has room. */
export const MOUNTED_FILE_EXCERPT_TOKENS = 4_000;

/** Smallest excerpt, even when the inline budget is already spent. */
export const MOUNTED_FILE_EXCERPT_MIN_TOKENS = 1_000;

/** How the model can reach the full text of an excerpted file. */
export type FullTextAccess = 'code' | 'tool';

/** Sheet markers written by xlsxToText (lib/utils/server/file/fileHandling.ts). */
const SHEET_MARKER = /^--- START OF SHEET: (.+) ---$/gm;

/** Most sheet names listed in the excerpt header. */
const SHEET_LIST_CAP = 20;

/**
 * Token size the excerpt should take, given what is left of the turn's
 * inline budget.
 *
 * @param remainingInlineTokens - Inline budget not yet used this turn
 *        (may be negative or fractional).
 * @returns Excerpt size in tokens, within
 *          [MOUNTED_FILE_EXCERPT_MIN_TOKENS, MOUNTED_FILE_EXCERPT_TOKENS].
 */
export function mountedExcerptTokens(remainingInlineTokens: number): number {
  return Math.min(
    MOUNTED_FILE_EXCERPT_TOKENS,
    Math.max(
      MOUNTED_FILE_EXCERPT_MIN_TOKENS,
      Math.floor(remainingInlineTokens),
    ),
  );
}

/**
 * Builds the inline text for a document that is too large for the turn's
 * inline budget but is mounted in the interpreter sandbox.
 *
 * The excerpt is cut at a line boundary (a CSV row is never split) and is
 * headed by a notice naming the mounted file, the share of the document
 * shown, and — for spreadsheets — every sheet name, since the opening rows
 * only cover the first sheet.
 *
 * @param text - The document's full extracted text.
 * @param filename - Name the file has in the sandbox.
 * @param maxChars - Character budget for the excerpt body (>= 0).
 * @returns The excerpt with its notice, or `text` unchanged if it already
 *          fits in `maxChars`.
 *
 * @example
 * buildMountedFileExcerpt(csvText, 'WB27.xlsx', 16_000);
 * // => "[Excerpt of WB27.xlsx: first ~9% shown. The complete file is …]\n\n<rows>"
 */
export function buildMountedFileExcerpt(
  text: string,
  filename: string,
  maxChars: number,
  /**
   * How the model reaches the rest: 'code' — the file is mounted in its
   * own interpreter sandbox (native interpreter turns); 'tool' — the
   * attachment reader tools serve the full text (attachmentReader.ts).
   */
  access: FullTextAccess = 'code',
): string {
  if (text.length <= maxChars) return text;

  const limit = Math.max(0, Math.floor(maxChars));
  const lastBreak = text.lastIndexOf('\n', limit);
  const body = text.slice(0, lastBreak > 0 ? lastBreak : limit);
  const shownPercent = Math.max(
    1,
    Math.floor((body.length / text.length) * 100),
  );

  const sheets = [...text.matchAll(SHEET_MARKER)].map((m) => m[1]);
  const sheetLine =
    sheets.length > 1
      ? ` It has ${sheets.length} sheets: ${sheets
          .slice(0, SHEET_LIST_CAP)
          .map((name) => `"${name}"`)
          .join(', ')}${sheets.length > SHEET_LIST_CAP ? ', …' : ''}.`
      : '';

  const reach =
    access === 'code'
      ? `The complete file is available to your code interpreter as "${filename}".${sheetLine} ` +
        'Read it with code for anything beyond this excerpt'
      : `The complete text is available through the search_attachment and read_attachment tools.${sheetLine} ` +
        'Use them for anything beyond this excerpt and the results above';
  const notice =
    `[Excerpt of ${filename}: the first ~${shownPercent}% of its extracted text is shown below. ` +
    `${reach} — never guess or invent values that are not shown here.]`;

  return `${notice}\n\n${body}`;
}

/** An attachment as the prompt carries it (processedContent.inlineFiles). */
export interface InlineFileContent {
  filename: string;
  content: string;
  isExcerpt?: boolean;
}

/**
 * Shortens already-inlined attachments once something else has read them in
 * full — the sub-tool interpreter on a non-native model — and the answering
 * model can still reach the full text (`access`). Same budget as a native
 * interpreter turn: small files stay whole within
 * MOUNTED_FILES_INLINE_BUDGET_TOKENS, larger ones become excerpts.
 *
 * @param files - The turn's inline files.
 * @param eligible - Lower-cased names of the files that were read in full.
 * @param access - How the model reaches the rest.
 * @param charsPerToken - Estimate for the token arithmetic.
 * @returns The new inline files, and the full text of each excerpted one.
 */
export function excerptInlineFilesForReaccess(
  files: readonly InlineFileContent[],
  eligible: ReadonlySet<string>,
  access: FullTextAccess,
  charsPerToken = 4,
): { inlineFiles: InlineFileContent[]; fullTexts: Record<string, string> } {
  const fullTexts: Record<string, string> = {};
  let usedTokens = 0;
  const inlineFiles = files.map((file) => {
    if (file.isExcerpt || !eligible.has(file.filename.toLowerCase()))
      return file;
    const tokens = file.content.length / charsPerToken;
    if (usedTokens + tokens <= MOUNTED_FILES_INLINE_BUDGET_TOKENS) {
      usedTokens += tokens;
      return file;
    }
    const excerptTokens = mountedExcerptTokens(
      MOUNTED_FILES_INLINE_BUDGET_TOKENS - usedTokens,
    );
    const excerpt = buildMountedFileExcerpt(
      file.content,
      file.filename,
      excerptTokens * charsPerToken,
      access,
    );
    if (excerpt === file.content) return file;
    usedTokens += excerpt.length / charsPerToken;
    fullTexts[file.filename] = file.content;
    return { ...file, content: excerpt, isExcerpt: true };
  });
  return { inlineFiles, fullTexts };
}
