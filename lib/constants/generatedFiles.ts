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
