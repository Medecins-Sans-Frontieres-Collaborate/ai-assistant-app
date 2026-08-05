import { ExtractionResultContent } from '@/types/chat';
import { Citation } from '@/types/rag';

/**
 * Transcript metadata for audio/video transcriptions
 */
export interface TranscriptMetadata {
  filename: string;
  transcript: string;
  processedContent?: string; // If user provided instructions for processing
  jobId?: string; // For tracking async transcription jobs and reliable message updates
}

/**
 * Pending transcription job info for async processing.
 *
 * Supports two job types:
 * - Chunked: Local processing with FFmpeg + Whisper (blobPath is optional)
 * - Batch: Azure Speech Services (blobPath is required for cleanup)
 */
export interface PendingTranscriptionInfo {
  filename: string;
  jobId: string;
  blobPath?: string; // Only required for batch jobs
  totalChunks?: number; // Only for chunked jobs
  jobType?: 'chunked' | 'batch';
}

/**
 * Real token usage for one chat request, as reported by the model provider
 * and attributed server-side. Travels in the terminal metadata block (and in
 * non-streaming JSON bodies) so the client can accumulate per-user stats.
 */
export interface TokenUsageMetadata {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** The model that ACTUALLY served (the fallback chain may have switched). */
  modelId: string;
  /** Resolved chat region; null = default (home) clients. */
  region: 'US' | 'EU' | null;
  /** The reasoning effort actually applied to the request, if any. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

/**
 * Metadata object that can be embedded in streamed responses
 */
export interface StreamMetadata {
  citations?: Citation[];
  threadId?: string;
  thinking?: string;
  transcript?: TranscriptMetadata;
  action?: string; // Current action being performed (e.g., "searching_web", "processing")
  pendingTranscriptions?: PendingTranscriptionInfo[]; // Async batch transcription jobs
  usage?: TokenUsageMetadata;
  fileCacheUpdates?: Array<{
    fileId: string;
    processedContent: {
      type: 'document' | 'transcript' | 'image';
      content: string;
      summary?: string;
      tokenEstimate: number;
      tokenEstimateEncoding?: string;
      processedAt: string;
    };
  }>;
  activeFilesTokensConsumed?: number;
  /**
   * IDs of active files that were excluded from this turn because they
   * didn't fit the per-turn token budget. Surfaced so the UI can flag
   * which pinned/active files are not visible to the model right now.
   */
  activeFilesDropped?: string[];
  /**
   * Structured-data extraction result. When present, the chat surface
   * replaces the assistant message's `content` with this payload and
   * renders it as a download card instead of a text body.
   */
  extractionResult?: ExtractionResultContent;
  /**
   * MCP turn plan (steps + progress + retry state). Rides the terminal
   * block so the client can echo it back on approval resume — the tool
   * loop is stateless server-side.
   */
  mcpPlan?: import('@/types/mcp').McpPlan;
  /**
   * Mid-stream failure, reported IN-BAND so the stream can end cleanly.
   * Aborting the response instead (controller.error) kills the socket and
   * surfaces browser-side as an opaque network error (Firefox:
   * NS_ERROR_NET_PARTIAL_TRANSFER) that the UI can only guess at. `message`
   * must be client-safe — provider error details stay in server logs.
   * `retry: true` marks the partial output as not worth keeping (e.g. it
   * promises a generated file that doesn't exist) — the client SHOULD
   * auto-retry on the fallback chain instead of surfacing the partial.
   */
  streamError?: { message: string; code?: string; retry?: boolean };
  /**
   * Retrieved chunk text per citation number, shipped by the server so the
   * client can verify model-claimed citation quotes are verbatim. TRANSIENT:
   * consumed during stream finalization, never persisted onto the message.
   */
  citationQuoteSources?: Record<string, string>;
}

/**
 * Result of parsing metadata from content
 */
export interface ParsedMetadata {
  content: string;
  citations: Citation[];
  threadId?: string;
  thinking?: string;
  transcript?: TranscriptMetadata;
  action?: string;
  pendingTranscriptions?: PendingTranscriptionInfo[];
  fileCacheUpdates?: StreamMetadata['fileCacheUpdates'];
  activeFilesTokensConsumed?: number;
  activeFilesDropped?: string[];
  usage?: TokenUsageMetadata;
  extractionResult?: ExtractionResultContent;
  streamError?: { message: string; code?: string; retry?: boolean };
  mcpPlan?: import('@/types/mcp').McpPlan;
  /**
   * Claim-supporting quotes the MODEL emitted in its own
   * `<<<CITATION_QUOTES>>>` block, keyed by citation number. UNVERIFIED at
   * this layer — display only after checking each against
   * `citationQuoteSources` (see applyClaimQuotes).
   */
  modelCitationQuotes?: Record<string, string>;
  /** Server-shipped chunk texts for quote verification (transient). */
  citationQuoteSources?: Record<string, string>;
  extractionMethod: 'metadata' | 'none';
  /**
   * Character index in the input string where the terminal
   * `<<<METADATA_START>>>` marker begins, or null if not present.
   * The inline-event scanner uses this to cap its scan so it doesn't
   * walk into the terminal metadata block.
   */
  metadataStartIndex: number | null;
}

/**
 * Opening marker of the terminal metadata block.
 *
 * Exported so stream consumers can detect a block that has STARTED but not
 * yet finished arriving — `parseMetadataFromContent` only reports
 * `metadataStartIndex` once a block is complete, which is not enough to keep
 * a half-arrived marker out of display text. See StreamParser.processChunk.
 */
export const METADATA_START_MARKER = '<<<METADATA_START>>>';

/**
 * Markers of the MODEL-EMITTED citation-quotes block (claim-level quote per
 * cited source, appended after the answer per the M365 agent prompt
 * contract). Distinct from the server's terminal metadata block: this one is
 * generated by the model, so its content is untrusted until verified.
 */
export const CITATION_QUOTES_START_MARKER = '<<<CITATION_QUOTES>>>';
export const CITATION_QUOTES_END_MARKER = '<<<END_CITATION_QUOTES>>>';

/**
 * Index at which a citation-quotes block begins (complete, unclosed, or a
 * partial start marker at the very end of the text), or -1. Per the prompt
 * contract nothing follows the block except the server's terminal metadata,
 * so stream consumers cap display text here the same way they do for a
 * pending metadata block. Includes an immediately-preceding `\n\n`.
 */
export function citationQuotesStartIndex(content: string): number {
  let index = content.indexOf(CITATION_QUOTES_START_MARKER);

  if (index === -1) {
    const maxPrefix = Math.min(
      CITATION_QUOTES_START_MARKER.length - 1,
      content.length,
    );
    for (let k = maxPrefix; k >= 1; k--) {
      if (content.endsWith(CITATION_QUOTES_START_MARKER.slice(0, k))) {
        index = content.length - k;
        break;
      }
    }
    if (index === -1) return -1;
  }

  return index >= 2 && content.slice(index - 2, index) === '\n\n'
    ? index - 2
    : index;
}

/**
 * Index at which an INCOMPLETE terminal metadata block begins, or -1.
 *
 * Covers both "the open marker is fully present but its closing marker
 * hasn't arrived" and "the tail of the text is a partial prefix of the open
 * marker" (e.g. the chunk ends with `<<<METADATA_ST`). Includes an
 * immediately-preceding `\n\n` separator so the returned index matches what
 * `metadataStartIndex` reports for a complete block.
 *
 * Callers use this to hold those bytes back until the rest arrives —
 * otherwise they leak into the rendered message and, because scan cursors are
 * monotonic, can never be retracted.
 */
export function pendingMetadataStartIndex(content: string): number {
  let index = content.indexOf(METADATA_START_MARKER);

  if (index === -1) {
    // No full open marker — look for a partial one at the very end.
    const maxPrefix = Math.min(
      METADATA_START_MARKER.length - 1,
      content.length,
    );
    for (let k = maxPrefix; k >= 1; k--) {
      if (content.endsWith(METADATA_START_MARKER.slice(0, k))) {
        index = content.length - k;
        break;
      }
    }
    if (index === -1) return -1;
  }

  // Match parseMetadataFromContent, whose index includes the optional
  // leading blank line, so display text doesn't keep a trailing gap.
  return index >= 2 && content.slice(index - 2, index) === '\n\n'
    ? index - 2
    : index;
}

/**
 * Parses metadata from content using the standard format
 * Format: <<<METADATA_START>>>{json}<<<METADATA_END>>>
 *
 * @param content The text content to parse
 * @returns Object containing the cleaned text and extracted metadata
 */
export function parseMetadataFromContent(content: string): ParsedMetadata {
  let mainContent = content;
  let citations: Citation[] = [];
  let threadId: string | undefined;
  let thinking: string | undefined;
  let transcript: TranscriptMetadata | undefined;
  let action: string | undefined;
  let pendingTranscriptions: PendingTranscriptionInfo[] | undefined;
  let fileCacheUpdates: StreamMetadata['fileCacheUpdates'] | undefined;
  let activeFilesTokensConsumed: number | undefined;
  let activeFilesDropped: string[] | undefined;
  let usage: TokenUsageMetadata | undefined;
  let extractionResult: ExtractionResultContent | undefined;
  let streamError: ParsedMetadata['streamError'];
  let mcpPlan: ParsedMetadata['mcpPlan'];
  let modelCitationQuotes: Record<string, string> | undefined;
  let citationQuoteSources: Record<string, string> | undefined;
  let extractionMethod: ParsedMetadata['extractionMethod'] = 'none';
  let metadataStartIndex: number | null = null;

  // Cheap exit when the marker isn't present at all — avoids running the
  // regex on long streams that have no terminal metadata block yet.
  const metaIdx = content.indexOf(METADATA_START_MARKER);
  // A stream can carry MULTIPLE terminal blocks (the stream processor's
  // usage/citations block, then StandardChatHandler's file_cache_update
  // block). Parse and strip ALL of them, merging per-field with later
  // blocks winning; only the first block's index caps the inline-event scan.
  // The `\n\n` prefix is optional: regular streamed responses carry it, but
  // extraction turns emit the block as the ENTIRE response (no prefix).
  const blockRegex = /(?:\n\n)?<<<METADATA_START>>>(.*?)<<<METADATA_END>>>/gs;
  const matches = metaIdx === -1 ? [] : [...content.matchAll(blockRegex)];
  if (matches.length > 0) {
    extractionMethod = 'metadata';
    // Record the start index (of the leading `\n\n` when present) so the
    // scanner caps its inline-event search before the first metadata block.
    metadataStartIndex = matches[0].index ?? metaIdx;
    mainContent = content.replace(blockRegex, '');

    for (const match of matches) {
      try {
        const parsedData = JSON.parse(match[1]) as Partial<StreamMetadata>;
        if (parsedData.citations) {
          citations = parsedData.citations;
        }
        if (parsedData.threadId) {
          threadId = parsedData.threadId;
        }
        if (parsedData.thinking) {
          thinking = parsedData.thinking;
        }
        if (parsedData.transcript) {
          transcript = parsedData.transcript;
        }
        if (parsedData.action) {
          action = parsedData.action;
        }
        if (parsedData.pendingTranscriptions) {
          pendingTranscriptions = parsedData.pendingTranscriptions;
        }
        if (parsedData.fileCacheUpdates) {
          fileCacheUpdates = parsedData.fileCacheUpdates;
        }
        if (typeof parsedData.activeFilesTokensConsumed === 'number') {
          activeFilesTokensConsumed = parsedData.activeFilesTokensConsumed;
        }
        if (Array.isArray(parsedData.activeFilesDropped)) {
          activeFilesDropped = parsedData.activeFilesDropped.filter(
            (id: unknown): id is string => typeof id === 'string',
          );
        }
        if (parsedData.usage) {
          usage = parsedData.usage;
        }
        if (parsedData.mcpPlan && Array.isArray(parsedData.mcpPlan.steps)) {
          mcpPlan = parsedData.mcpPlan;
        }
        if (
          parsedData.citationQuoteSources &&
          typeof parsedData.citationQuoteSources === 'object'
        ) {
          // Same shape filter as modelCitationQuotes below: a non-string
          // value here would throw inside applyClaimQuotes (normalize calls
          // .toLowerCase()) and break citation rendering for the message.
          const sourceEntries = Object.entries(
            parsedData.citationQuoteSources as Record<string, unknown>,
          ).filter(
            (entry): entry is [string, string] =>
              /^\d+$/.test(entry[0]) && typeof entry[1] === 'string',
          );
          if (sourceEntries.length > 0) {
            citationQuoteSources = Object.fromEntries(sourceEntries);
          }
        }
        if (
          parsedData.streamError &&
          typeof parsedData.streamError.message === 'string'
        ) {
          streamError = {
            message: parsedData.streamError.message,
            ...(typeof parsedData.streamError.code === 'string'
              ? { code: parsedData.streamError.code }
              : {}),
            ...(parsedData.streamError.retry === true ? { retry: true } : {}),
          };
        }
        const anyData = parsedData as unknown as {
          extractionResult?: unknown;
        };
        if (
          anyData.extractionResult &&
          typeof anyData.extractionResult === 'object' &&
          (anyData.extractionResult as { type?: string }).type ===
            'extraction_result'
        ) {
          extractionResult =
            anyData.extractionResult as ExtractionResultContent;
        }
      } catch (error) {
        console.error('Error parsing metadata JSON:', error);
      }
    }
  }

  // Model-emitted citation-quotes block: strip from display text and
  // capture the (unverified) claim quotes. Malformed JSON simply drops the
  // block — the extractive-caption fallback quote stays in place.
  if (mainContent.includes(CITATION_QUOTES_START_MARKER)) {
    const quotesRegex =
      /(?:\n\n)?<<<CITATION_QUOTES>>>(.*?)<<<END_CITATION_QUOTES>>>/gs;
    for (const match of mainContent.matchAll(quotesRegex)) {
      try {
        const parsedQuotes = JSON.parse(match[1]) as unknown;
        if (parsedQuotes && typeof parsedQuotes === 'object') {
          const entries = Object.entries(
            parsedQuotes as Record<string, unknown>,
          ).filter(
            (entry): entry is [string, string] =>
              /^\d+$/.test(entry[0]) && typeof entry[1] === 'string',
          );
          if (entries.length > 0) {
            modelCitationQuotes = Object.fromEntries(entries);
          }
        }
      } catch {
        // Untrusted model output — a mangled block is expected sometimes.
      }
    }
    mainContent = mainContent.replace(quotesRegex, '');
  }

  // Clean up trailing citation lists (e.g., "[1] [2] [3] [4]" at the end)
  // Note: Don't use .trim() here as it removes newlines needed for markdown formatting
  mainContent = mainContent.replace(/\n*\s*(?:\[\d+\]\s*)+\s*$/g, '');

  return {
    content: mainContent,
    citations,
    threadId,
    thinking,
    transcript,
    action,
    pendingTranscriptions,
    fileCacheUpdates,
    activeFilesTokensConsumed,
    activeFilesDropped,
    usage,
    extractionResult,
    streamError,
    mcpPlan,
    modelCitationQuotes,
    citationQuoteSources,
    extractionMethod,
    metadataStartIndex,
  };
}

/**
 * Appends metadata to a readable stream in the standard format
 * Uses the <<<METADATA_START>>>{json}<<<METADATA_END>>> format
 *
 * @param controller The ReadableStream controller
 * @param metadata The metadata to append
 */
export function appendMetadataToStream(
  controller: ReadableStreamDefaultController,
  metadata: StreamMetadata,
): void {
  const encoder = new TextEncoder();
  const separator = '\n\n<<<METADATA_START>>>';

  // Filter out undefined values
  const cleanMetadata: Partial<StreamMetadata> = {};
  if (metadata.citations) cleanMetadata.citations = metadata.citations;
  if (metadata.threadId) cleanMetadata.threadId = metadata.threadId;
  if (metadata.thinking) cleanMetadata.thinking = metadata.thinking;
  if (metadata.transcript) cleanMetadata.transcript = metadata.transcript;
  if (metadata.action) cleanMetadata.action = metadata.action;
  if (metadata.pendingTranscriptions)
    cleanMetadata.pendingTranscriptions = metadata.pendingTranscriptions;
  if (metadata.usage) cleanMetadata.usage = metadata.usage;
  if (metadata.streamError) cleanMetadata.streamError = metadata.streamError;
  if (metadata.mcpPlan) cleanMetadata.mcpPlan = metadata.mcpPlan;

  // Only append if we have actual metadata
  if (Object.keys(cleanMetadata).length > 0) {
    const metadataStr = `${separator}${JSON.stringify(cleanMetadata)}<<<METADATA_END>>>`;
    controller.enqueue(encoder.encode(metadataStr));
  }
}

/**
 * Creates a TextEncoder instance for stream encoding
 * Can be used for consistent encoder creation across the codebase
 */
export function createStreamEncoder(): TextEncoder {
  return new TextEncoder();
}

/**
 * Creates a TextDecoder instance for stream decoding
 * Can be used for consistent decoder creation across the codebase
 */
export function createStreamDecoder(): TextDecoder {
  return new TextDecoder();
}

/**
 * Deduplicates citations by URL or title
 *
 * @param citations - Array of citations to deduplicate
 * @returns Deduplicated citations with sequential numbering starting from 1
 */
export function deduplicateCitations(citations: Citation[]): Citation[] {
  const uniqueCitationsMap = new Map<string, Citation>();

  for (const citation of citations) {
    const key = citation.url || citation.title;
    if (!key) continue;

    if (!uniqueCitationsMap.has(key)) {
      uniqueCitationsMap.set(key, citation);
    }
  }

  // Renumber sequentially
  const dedupedCitations: Citation[] = [];
  let number = 1;
  for (const citation of uniqueCitationsMap.values()) {
    dedupedCitations.push({
      ...citation,
      number: number++,
    });
  }

  return dedupedCitations;
}
