/**
 * Built-in tools that let the answering model go back to the FULL text of
 * an attached file it was only shown in part.
 *
 * A large attachment reaches the model as an excerpt (when the code
 * interpreter has already read it in full) or as a summary (when it does
 * not fit the context window). Both are the right default — they keep the
 * prompt small on every model call — but neither may be the end of the
 * road: when the answer needs a passage the excerpt or summary lacks, the
 * model searches or reads the original here instead of guessing or
 * telling the user it cannot see the file.
 *
 * Read-only and in-process (`immediate`), so calls run inside the request
 * without an approval round-trip. A per-turn character budget keeps the
 * model from pulling a whole document back into the context window it was
 * excerpted to protect.
 */
import type {
  BuiltinExecutor,
  BuiltinToolDefinition,
  BuiltinToolResult,
} from '@/lib/services/mcp/builtinExecutor';

import { normalizeForSearch } from '@/lib/utils/app/localeSearch';

import type { ResolvedMcpServer } from '@/config/mcpCatalog';

export const ATTACHMENT_SERVER_ID = 'builtin-attachments';

/** Synthetic, url-less server entry for the tool loop (like builtin-skills). */
export const buildAttachmentServer = (): ResolvedMcpServer => ({
  id: ATTACHMENT_SERVER_ID,
  label: 'Attached files',
  url: '',
  transport: 'streamable-http',
  auth: { style: 'none' },
  trusted: true,
  provenance: 'builtin',
});

/** Characters returned by one read (~6K tokens), cut at a line break. */
export const ATTACHMENT_READ_CHUNK_CHARS = 24_000;

/** Characters all calls together may return in one turn (~30K tokens). */
export const ATTACHMENT_TURN_BUDGET_CHARS = 120_000;

/** Most passages one search returns. */
export const ATTACHMENT_SEARCH_MAX_HITS = 20;

/** Longest line shown in a search hit (the rest is elided). */
const SEARCH_LINE_CHARS = 400;

const READ_TOOL = 'read_attachment';
const SEARCH_TOOL = 'search_attachment';

interface Line {
  offset: number;
  text: string;
}

/** Splits text into lines that remember their character offset. */
function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    lines.push({ offset, text: line });
    offset += line.length + 1;
  }
  return lines;
}

const clip = (text: string) =>
  text.length > SEARCH_LINE_CHARS
    ? `${text.slice(0, SEARCH_LINE_CHARS)}…`
    : text;

/**
 * Creates the attachment reader for one turn.
 *
 * @param texts - Full extracted text by filename, for the files the prompt
 *        carries only as an excerpt or summary.
 * @returns The executor, or undefined when there is nothing to read.
 */
export function createAttachmentReader(
  texts: Readonly<Record<string, string>>,
): BuiltinExecutor | undefined {
  const files = Object.entries(texts).filter(([, text]) => text.length > 0);
  if (files.length === 0) return undefined;
  const filenames = files.map(([name]) => name);
  const byName = new Map(
    files.map(([name, text]) => [name.toLowerCase(), { name, text }]),
  );
  let remainingChars = ATTACHMENT_TURN_BUDGET_CHARS;

  const fail = (resultText: string): BuiltinToolResult => ({
    resultText,
    isError: true,
  });
  const resolve = (filename: unknown) =>
    typeof filename === 'string'
      ? byName.get(filename.trim().toLowerCase())
      : undefined;
  const budgetSpent = () =>
    fail(
      'The reading budget for this answer is used up. Answer from what you have read, and say which parts of the file you could not check.',
    );

  function read(args: Record<string, unknown>): BuiltinToolResult {
    const file = resolve(args.filename);
    if (!file) return fail(`Unknown file. Available: ${filenames.join(', ')}`);
    if (remainingChars <= 0) return budgetSpent();
    const total = file.text.length;
    const start = Math.min(
      Math.max(0, Math.floor(Number(args.start) || 0)),
      total,
    );
    const limit = Math.min(ATTACHMENT_READ_CHUNK_CHARS, remainingChars);
    let end = Math.min(total, start + limit);
    if (end < total) {
      const lineBreak = file.text.lastIndexOf('\n', end);
      if (lineBreak > start) end = lineBreak + 1;
    }
    const body = file.text.slice(start, end);
    remainingChars -= body.length;
    const position =
      end < total
        ? `[${file.name}: characters ${start}–${end} of ${total}. Call ${READ_TOOL} with start=${end} to continue.]`
        : `[${file.name}: characters ${start}–${end} of ${total} — end of file.]`;
    return { resultText: `${position}\n\n${body}`, isError: false };
  }

  function search(args: Record<string, unknown>): BuiltinToolResult {
    const file = resolve(args.filename);
    if (!file) return fail(`Unknown file. Available: ${filenames.join(', ')}`);
    if (remainingChars <= 0) return budgetSpent();
    const query = typeof args.query === 'string' ? args.query : '';
    const phrase = normalizeForSearch(query);
    if (!phrase) return fail('Give a non-empty query.');
    const terms = phrase.split(/\s+/).filter(Boolean);
    const maxHits = Math.min(
      ATTACHMENT_SEARCH_MAX_HITS,
      Math.max(1, Math.floor(Number(args.max_results) || 10)),
    );

    const lines = linesOf(file.text);
    const normalized = lines.map((line) => normalizeForSearch(line.text));
    // The exact phrase first; failing that, lines carrying every term.
    let hits = normalized.flatMap((line, i) =>
      line.includes(phrase) ? [i] : [],
    );
    if (hits.length === 0 && terms.length > 1)
      hits = normalized.flatMap((line, i) =>
        terms.every((term) => line.includes(term)) ? [i] : [],
      );
    if (hits.length === 0)
      return {
        resultText: `No passage of ${file.name} matches "${query}". Try other words, or read the file with ${READ_TOOL}.`,
        isError: false,
      };

    const shown = hits.slice(0, maxHits).map((i) => {
      const before = lines[i - 1]?.text.trim();
      const after = lines[i + 1]?.text.trim();
      return [
        `@${lines[i].offset}:`,
        ...(before ? [`  ${clip(before)}`] : []),
        `> ${clip(lines[i].text.trim())}`,
        ...(after ? [`  ${clip(after)}`] : []),
      ].join('\n');
    });
    const more =
      hits.length > maxHits ? ` (showing ${maxHits} of ${hits.length})` : '';
    const resultText =
      `${hits.length} passage(s) of ${file.name} match "${query}"${more}. ` +
      `Each starts with its character offset; call ${READ_TOOL} with that start for the full context.\n\n` +
      shown.join('\n\n');
    remainingChars -= resultText.length;
    return { resultText, isError: false };
  }

  const fileParameter = {
    type: 'string',
    enum: filenames,
    description: 'The attached file, by its exact name.',
  };
  const tools: BuiltinToolDefinition[] = [
    {
      name: SEARCH_TOOL,
      description:
        'Find passages in the FULL text of an attached file that you were shown only as an excerpt or summary. Returns matching lines with their character offsets.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: fileParameter,
          query: {
            type: 'string',
            description:
              'Words or a phrase to find (case and accents ignored), e.g. an indicator name or a year.',
          },
          max_results: {
            type: 'integer',
            minimum: 1,
            maximum: ATTACHMENT_SEARCH_MAX_HITS,
          },
        },
        required: ['filename', 'query'],
        additionalProperties: false,
      },
    },
    {
      name: READ_TOOL,
      description:
        'Read the FULL text of an attached file you were shown only as an excerpt or summary, from a character offset, one page (~6,000 tokens) at a time.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: fileParameter,
          start: {
            type: 'integer',
            minimum: 0,
            description:
              'Character offset to start from (0 = beginning; use an offset from a search result or a previous read).',
          },
        },
        required: ['filename'],
        additionalProperties: false,
      },
    },
  ];

  return {
    immediate: true,
    instructions:
      `The full text of these attached files is available even though you were shown only an excerpt or summary: ${filenames.join(', ')}. ` +
      `When your answer needs something the excerpt, summary or results above do not contain, use ${SEARCH_TOOL} to find it and ${READ_TOOL} to read it — never guess values or claim you cannot see the file. ` +
      'Do not re-read what you were already given.',
    async listTools() {
      return tools;
    },
    async callTool(name, args) {
      const input = (args && typeof args === 'object' ? args : {}) as Record<
        string,
        unknown
      >;
      if (name === READ_TOOL) return read(input);
      if (name === SEARCH_TOOL) return search(input);
      return fail(`Unknown tool ${name}`);
    },
    // The browser gets a one-line record, never the document text.
    recordOutput(name, args, result) {
      const input = (args ?? {}) as Record<string, unknown>;
      if (result.isError) return result.resultText;
      return name === SEARCH_TOOL
        ? `Searched ${String(input.filename)} for "${String(input.query)}"`
        : (result.resultText.split('\n', 1)[0] ?? '');
    },
  };
}
