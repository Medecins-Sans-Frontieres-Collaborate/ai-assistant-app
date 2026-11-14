/**
 * Files the code interpreter produces (`GeneratedFileRef` on a tool-call
 * record). Shared by the client (auto-activation after a turn), the
 * validator (what survives the API boundary) and the enrichers (manifest +
 * interpreter remount), so all three agree on what "text-like" means.
 *
 * Issue #126: a generated script only ever existed as a download link, so
 * on the next turn the model had nothing to read and asked the user to
 * provide the file it had just written.
 */

/** Extensions whose bytes are plain text a model can read directly. */
export const GENERATED_FILE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'html',
  'htm',
  'css',
  'sql',
  'py',
  'js',
  'mjs',
  'ts',
  'jsx',
  'tsx',
  'sh',
  'bash',
  'ps1',
  'bat',
  'cmd',
  'vbs',
  'vba',
  'bas',
  'cls',
  'r',
  'rb',
  'php',
  'java',
  'c',
  'h',
  'cpp',
  'cs',
  'go',
  'rs',
  'swift',
  'kt',
  'tex',
  'rtf',
  'log',
  'svg',
]);

/**
 * Office/document containers the active-file extractor turns into text.
 * Activated like text files; content comes from server-side extraction.
 */
export const GENERATED_FILE_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'odt',
]);

/**
 * Largest generated file auto-activated after a turn. Active files persist
 * their extracted text inside the conversation (localStorage), so this sits
 * far below the general active-file cap: scripts and small data files, not
 * bulk exports. Larger files still appear in the manifest by name.
 */
export const GENERATED_FILE_ACTIVATION_MAX_BYTES = 256_000;

/** Most recent generated files listed in the model-facing manifest. */
export const GENERATED_FILE_MANIFEST_MAX_ENTRIES = 20;

export function generatedFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * Whether a generated file's content can be handed to the model as text
 * (directly, or via the document extractor).
 */
export function isTextLikeGeneratedFile(
  filename: string,
  mimeType?: string,
): boolean {
  const ext = generatedFileExtension(filename);
  if (GENERATED_FILE_TEXT_EXTENSIONS.has(ext)) return true;
  if (GENERATED_FILE_DOCUMENT_EXTENSIONS.has(ext)) return true;
  return !!mimeType && /^text\//i.test(mimeType) && !!ext;
}

/**
 * Blob id (`<sha256>.<ext>`) behind an app-relative generated-file URL
 * (`/api/file/<sha256>.<ext>`); null for anything else.
 */
export function generatedFileBlobId(url: string): string | null {
  const match = /^\/api\/file\/([A-Za-z0-9._-]+)$/.exec(url.split('?')[0]);
  return match ? match[1] : null;
}

export function formatGeneratedFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Smallest body-text size, in points, a generated document may use. */
export const GENERATED_DOCUMENT_MIN_BODY_PT = 10;

/** Smallest size, in points, for tables, footnotes and captions. */
export const GENERATED_DOCUMENT_MIN_TABLE_PT = 9;

/**
 * Layout rule for documents the code interpreter writes (.docx, .pptx, .pdf).
 * Shared by the main system prompt (native interpreter) and the sub-tool
 * interpreter's task preamble so both paths hold the same floor.
 *
 * Why: asked for a four-page review, the model met the page limit by setting
 * table text to 6.5-7 pt (reproduced 2026-11-07, Tongolo review) even though
 * the user had forbidden unreadably small text. A length limit has to be met
 * by writing less, not by shrinking the type.
 *
 * The first wording (sizes plus "never shrink") was ignored on a live rerun
 * the same day: Normal 8.5 pt, tables 7 pt. The model had a hard page limit
 * and no permitted way out of it, so the rule is stated in the code the
 * model writes (Pt values) and gives it one: go slightly over, and say so.
 */
export const GENERATED_DOCUMENT_LAYOUT_RULE =
  `Readable type is a hard rule for every document you generate. In python-docx, set the Normal style to Pt(${GENERATED_DOCUMENT_MIN_BODY_PT}) or larger ` +
  `and never pass anything below Pt(${GENERATED_DOCUMENT_MIN_TABLE_PT}) for a run, table cell, footnote or caption (in any other library: body at least ${GENERATED_DOCUMENT_MIN_BODY_PT} pt, everything else at least ${GENERATED_DOCUMENT_MIN_TABLE_PT} pt). ` +
  'A page or length limit is met by cutting and condensing content (fewer words, merged table columns, detail moved to an annex), never by smaller type, narrower margins or tighter spacing. ' +
  'If the essential content cannot fit at these sizes, deliver it slightly over the limit and tell the user, rather than shrinking it.';

/**
 * When a request should end in a FILE and when in TEXT in the chat. Shared by
 * the main system prompt and the native interpreter's instructions so both
 * state the same rule; the tool router carries a longer form of it
 * (ToolRouterService) because it has to classify, not just comply.
 *
 * Why: "reword this email" with the email attached came back as a file to
 * download instead of the reworded text (browser runs 2026-11-13, Mistral
 * via the router and GPT-5.2 on the native path, in English, French, Arabic
 * and Spanish). An attachment is where the content lives, not a request for
 * a file back.
 */
export const FILE_OR_CHAT_DELIVERABLE_RULE =
  'Create a file only when a file is the deliverable: the user asks for one (a file, document, download, or "the updated version"), ' +
  'asks to change an attached presentation, spreadsheet, or dataset, or asks for a whole formatted document (report, memo, proposal) to be shortened, lengthened, restructured, reformatted, converted, or translated. ' +
  'When the user asks to reword, correct, shorten, translate, or reply to a short message they attached (an email, note, letter, or post), to improve one passage of a document, ' +
  'or to summarize or answer questions about an attachment or web page, reply with the text itself in the chat and do NOT create a file — a file would hide the answer behind a download.';
