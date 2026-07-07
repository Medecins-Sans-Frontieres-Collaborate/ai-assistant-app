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
  let extractionMethod: ParsedMetadata['extractionMethod'] = 'none';
  let metadataStartIndex: number | null = null;

  // Cheap exit when the marker isn't present at all — avoids running the
  // regex on long streams that have no terminal metadata block yet.
  const metaIdx = content.indexOf('<<<METADATA_START>>>');
  // A stream can carry MULTIPLE terminal blocks (the stream processor's
  // usage/citations block, then StandardChatHandler's file_cache_update
  // block). Parse and strip ALL of them, merging per-field with later
  // blocks winning; only the first block's index caps the inline-event scan.
  const blockRegex = /\n\n<<<METADATA_START>>>(.*?)<<<METADATA_END>>>/gs;
  const matches = metaIdx === -1 ? [] : [...content.matchAll(blockRegex)];
  if (matches.length > 0) {
    extractionMethod = 'metadata';
    // Record the start index of the leading `\n\n` so the scanner caps
    // its inline-event search before the first metadata block.
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
      } catch (error) {
        console.error('Error parsing metadata JSON:', error);
      }
    }
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
