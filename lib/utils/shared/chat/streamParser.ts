import {
  PendingTranscriptionInfo,
  StreamMetadata,
  TranscriptMetadata,
  createStreamDecoder,
  parseMetadataFromContent,
} from '@/lib/utils/app/metadata';

import { Message, MessageType } from '@/types/chat';
import { Citation } from '@/types/rag';

import {
  ConsentOutcomePayload,
  extractConsentOutcomes,
  extractLatestAgentActivity,
} from '@/lib/streamMarkers';

/**
 * Handles parsing of streaming chat responses
 * Extracts metadata (citations, transcripts, actions) and display content
 */
export class StreamParser {
  private text: string = '';
  private extractedCitations: Citation[] = [];
  private extractedThreadId?: string;
  private extractedTranscript?: TranscriptMetadata;
  private extractedPendingTranscriptions?: PendingTranscriptionInfo[];
  private extractedFileCacheUpdates?: StreamMetadata['fileCacheUpdates'];
  private extractedActiveFilesTokensConsumed?: number;
  private extractedActiveFilesDropped?: string[];
  private hasReceivedContent: boolean = false;
  private prevDisplayText: string = '';
  private prevCitationsStr: string = '[]';
  // CONSENT_OUTCOME markers are side-effect-only. Track which ones we've
  // already surfaced so processChunk only returns newly-arrived outcomes.
  // Lifetime: instance-scoped — every chat send constructs a fresh
  // StreamParser, so this Set never persists across streams.
  private seenOutcomeIds: Set<string> = new Set();

  constructor(private decoder = createStreamDecoder()) {}

  /**
   * Process a chunk from the stream
   * Returns the current state after processing
   */
  processChunk(
    value: Uint8Array,
    options: { stream: boolean } = { stream: true },
  ): {
    displayText: string;
    citations: Citation[];
    hasReceivedContent: boolean;
    action?: string;
    contentChanged: boolean;
    citationsChanged: boolean;
    /** Newly-arrived approval outcomes since the previous chunk. */
    newOutcomes: ConsentOutcomePayload[];
  } {
    const chunk = this.decoder.decode(value, options);
    this.text += chunk;

    const parsed = parseMetadataFromContent(this.text);

    // Pull all CONSENT_OUTCOME markers, dedupe against ones we've already
    // surfaced, and strip them so they never reach the rendered content.
    const { outcomes, cleaned: outcomeStripped } = extractConsentOutcomes(
      parsed.content,
    );
    const newOutcomes: ConsentOutcomePayload[] = [];
    for (const o of outcomes) {
      if (!this.seenOutcomeIds.has(o.approval_request_id)) {
        this.seenOutcomeIds.add(o.approval_request_id);
        newOutcomes.push(o);
      }
    }
    // Pull the latest transient agent-activity marker (drives the loading
    // text) and strip all of them from the visible content.
    const { latest: latestActivity, cleaned: displayText } =
      extractLatestAgentActivity(outcomeStripped);
    const latestActivityKey = latestActivity?.key;

    // Update citations if found and different from previous
    const currentCitationsStr = JSON.stringify(parsed.citations);
    const citationsChanged =
      parsed.citations.length > 0 &&
      currentCitationsStr !== this.prevCitationsStr;

    if (citationsChanged) {
      this.extractedCitations = parsed.citations;
      this.prevCitationsStr = currentCitationsStr;
    }

    // Update threadId if found (only once)
    if (parsed.threadId && !this.extractedThreadId) {
      this.extractedThreadId = parsed.threadId;
    }

    // Update transcript if found (only once)
    if (parsed.transcript && !this.extractedTranscript) {
      this.extractedTranscript = parsed.transcript;
    }

    // Update pending transcriptions if found (only once)
    if (parsed.pendingTranscriptions && !this.extractedPendingTranscriptions) {
      this.extractedPendingTranscriptions = parsed.pendingTranscriptions;
    }

    // Capture file cache updates if present
    if (parsed.fileCacheUpdates && !this.extractedFileCacheUpdates) {
      this.extractedFileCacheUpdates = parsed.fileCacheUpdates;
    }

    // Capture active files tokens consumed if present
    if (
      parsed.activeFilesTokensConsumed != null &&
      this.extractedActiveFilesTokensConsumed == null
    ) {
      this.extractedActiveFilesTokensConsumed =
        parsed.activeFilesTokensConsumed;
    }

    // Capture dropped active file IDs if present
    if (parsed.activeFilesDropped && this.extractedActiveFilesDropped == null) {
      this.extractedActiveFilesDropped = parsed.activeFilesDropped;
    }

    // Check if we've received actual content (not just metadata)
    if (displayText && displayText.trim().length > 0) {
      this.hasReceivedContent = true;
    }

    const contentChanged = displayText !== this.prevDisplayText;
    this.prevDisplayText = displayText;

    return {
      displayText,
      citations: this.extractedCitations,
      hasReceivedContent: this.hasReceivedContent,
      // Transient activity key (if any) takes precedence over a
      // metadata-channel `action` field; both feed the same loading text.
      action: latestActivityKey ?? parsed.action,
      contentChanged,
      citationsChanged,
      newOutcomes,
    };
  }

  /**
   * Finalize the stream and perform final decode
   */
  finalize(): string {
    const finalChunk = this.decoder.decode();
    if (finalChunk) {
      this.text += finalChunk;
    }

    // Handle non-streaming JSON responses (like o3)
    let finalText = this.prevDisplayText || this.text;
    if (finalText.trim().startsWith('{') && finalText.trim().endsWith('}')) {
      try {
        const jsonResponse = JSON.parse(finalText);
        if (jsonResponse.text) {
          finalText = jsonResponse.text;
        }
      } catch (e) {
        // Not JSON or parsing failed, use text as-is
      }
    }

    return finalText;
  }

  /**
   * Convert parsed stream to a complete assistant message
   */
  toMessage(content: string): Message {
    return {
      role: 'assistant',
      content,
      messageType: MessageType.TEXT,
      citations:
        this.extractedCitations.length > 0
          ? this.extractedCitations
          : undefined,
      transcript: this.extractedTranscript,
    };
  }

  /**
   * Get the current citations
   */
  getCitations(): Citation[] {
    return this.extractedCitations;
  }

  /**
   * Get the thread ID if extracted
   */
  getThreadId(): string | undefined {
    return this.extractedThreadId;
  }

  /**
   * Get the transcript if extracted
   */
  getTranscript(): TranscriptMetadata | undefined {
    return this.extractedTranscript;
  }

  /**
   * Get pending transcriptions if extracted
   */
  getPendingTranscriptions(): PendingTranscriptionInfo[] | undefined {
    return this.extractedPendingTranscriptions;
  }

  /**
   * Get any file cache updates sent via SSE metadata
   */
  getFileCacheUpdates(): StreamMetadata['fileCacheUpdates'] | undefined {
    return this.extractedFileCacheUpdates;
  }

  /**
   * Get the number of active file tokens consumed this turn (from SSE metadata)
   */
  getActiveFilesTokensConsumed(): number | undefined {
    return this.extractedActiveFilesTokensConsumed;
  }

  /**
   * Get the active file IDs that were excluded from this turn's context
   * because they didn't fit the per-turn budget (from SSE metadata).
   */
  getActiveFilesDropped(): string[] | undefined {
    return this.extractedActiveFilesDropped;
  }

  /**
   * Check if any content has been received
   */
  getHasReceivedContent(): boolean {
    return this.hasReceivedContent;
  }
}
