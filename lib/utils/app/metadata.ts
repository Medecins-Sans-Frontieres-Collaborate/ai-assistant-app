import { CodeInterpreterMetadata } from '@/types/codeInterpreter';
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
 * Metadata object that can be embedded in streamed responses
 */
export interface StreamMetadata {
  citations?: Citation[];
  threadId?: string;
  thinking?: string;
  transcript?: TranscriptMetadata;
  action?: string; // Current action being performed (e.g., "searching_web", "processing", "executing_code")
  pendingTranscriptions?: PendingTranscriptionInfo[]; // Async batch transcription jobs
  codeInterpreter?: CodeInterpreterMetadata; // Code Interpreter execution metadata
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
  codeInterpreter?: CodeInterpreterMetadata;
  extractionMethod: 'metadata' | 'none';
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
  let extractionMethod: ParsedMetadata['extractionMethod'] = 'none';

  // Check for metadata format
  const metadataMatch = content.match(
    /\n\n<<<METADATA_START>>>(.*?)<<<METADATA_END>>>/s,
  );
  if (metadataMatch) {
    extractionMethod = 'metadata';
    mainContent = content.replace(
      /\n\n<<<METADATA_START>>>.*?<<<METADATA_END>>>/s,
      '',
    );

    try {
      const parsedData = JSON.parse(metadataMatch[1]);
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
    } catch (error) {
      console.error('Error parsing metadata JSON:', error);
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
    extractionMethod,
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
