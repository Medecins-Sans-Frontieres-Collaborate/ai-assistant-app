import {
  PendingTranscriptionInfo,
  StreamMetadata,
  TranscriptMetadata,
  createStreamDecoder,
  parseMetadataFromContent,
} from '@/lib/utils/app/metadata';

import { Message, MessageType, ToolCallRecord } from '@/types/chat';
import { Citation } from '@/types/rag';

import {
  AgentActivityPayload,
  ConsentOutcomePayload,
  ConsentRequestPayload,
  ToolCallRecordPayload,
  scanStreamEvents,
} from '@/lib/streamMarkers';

/**
 * Parses streaming chat responses. Forward-only: each chunk scans only
 * the suffix past `processedIndex`, so total work is O(stream_size) and
 * not O(stream_size²).
 */
export class StreamParser {
  private text: string = '';
  /** Bytes before this index are either in `displayText` or were events. */
  private processedIndex: number = 0;
  /** What the markdown renderer sees. Incomplete marker tails are excluded. */
  private displayText: string = '';
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
  // Drives the loading text — only the latest activity is shown.
  private latestActivity: AgentActivityPayload | null = null;
  // Outcomes already surfaced; processChunk only returns new ones.
  private seenOutcomeIds: Set<string> = new Set();
  // Tool calls keyed by id (defensive dedupe vs Foundry's `.added`/`.done`).
  private toolCallRecords: Map<string, ToolCallRecordPayload> = new Map();
  // Consent prompts in arrival order, deduped by oauth url / approval id.
  private consentRequests: ConsentRequestPayload[] = [];
  private seenConsentKeys: Set<string> = new Set();

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
    /** Optional interpolation params for the latest activity translation. */
    actionParams?: Record<string, string>;
    /** Whether the consent-card or tool-call lists changed this chunk. */
    consentChanged: boolean;
    toolCallsChanged: boolean;
  } {
    const chunk = this.decoder.decode(value, options);
    this.text += chunk;

    // Terminal METADATA block (citations, threadId, etc.). Cheap when
    // the marker isn't present — parseMetadataFromContent short-circuits.
    const parsed = parseMetadataFromContent(this.text);

    // Cap the inline-event scan at the start of the METADATA block once
    // it appears, so we never walk into it.
    let scanEnd = this.text.length;
    if (parsed.metadataStartIndex != null) {
      scanEnd = Math.min(scanEnd, parsed.metadataStartIndex);
    }
    const scanInput =
      scanEnd === this.text.length ? this.text : this.text.slice(0, scanEnd);
    const scan = scanStreamEvents(scanInput, this.processedIndex);

    const newOutcomes: ConsentOutcomePayload[] = [];
    let consentChanged = false;
    let toolCallsChanged = false;
    for (const event of scan.events) {
      switch (event.type) {
        case 'agent_activity':
          this.latestActivity = event.payload;
          break;
        case 'consent_outcome': {
          const id = event.payload.approval_request_id;
          if (!this.seenOutcomeIds.has(id)) {
            this.seenOutcomeIds.add(id);
            newOutcomes.push(event.payload);
          }
          break;
        }
        case 'consent_request': {
          const req = event.payload;
          const key =
            req.kind === 'oauth'
              ? `oauth:${req.consent_url ?? ''}`
              : `approval:${req.approval_request_id ?? req.tool_name ?? ''}`;
          if (!this.seenConsentKeys.has(key)) {
            this.seenConsentKeys.add(key);
            this.consentRequests.push(req);
            consentChanged = true;
          }
          break;
        }
        case 'tool_call_record': {
          this.toolCallRecords.set(event.payload.id, event.payload);
          toolCallsChanged = true;
          break;
        }
      }
    }

    this.processedIndex = scan.nextIndex;
    if (scan.displayDelta) {
      this.displayText += scan.displayDelta;
    }

    // Strip dangling "[1] [2]" citation indices at the end so the CitationList
    // below the message owns citation display. Derived per-render — the raw
    // accumulator keeps all bytes in case a later chunk extends past them.
    const renderedDisplayText = this.displayText.replace(
      /\n*\s*(?:\[\d+\]\s*)+\s*$/g,
      '',
    );

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

    // `hasReceivedContent` checks the raw accumulator so a citations-only
    // response (`[1] [2]`) still clears the loading state. `contentChanged`
    // compares the rendered text so we don't repaint when only trailing
    // citation indices changed.
    if (this.displayText && this.displayText.trim().length > 0) {
      this.hasReceivedContent = true;
    }

    const contentChanged = renderedDisplayText !== this.prevDisplayText;
    this.prevDisplayText = renderedDisplayText;

    return {
      displayText: renderedDisplayText,
      citations: this.extractedCitations,
      hasReceivedContent: this.hasReceivedContent,
      // Transient activity key (if any) takes precedence over a
      // metadata-channel `action` field; both feed the same loading text.
      action: this.latestActivity?.key ?? parsed.action,
      contentChanged,
      citationsChanged,
      newOutcomes,
      actionParams: this.latestActivity?.params,
      consentChanged,
      toolCallsChanged,
    };
  }

  /** Consent prompts seen so far, in arrival order. */
  getConsentRequests(): ConsentRequestPayload[] {
    return this.consentRequests;
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

  /**
   * All tool-call records accumulated during the stream, in the order they
   * arrived (Map preserves insertion order). Empty array when the agent
   * didn't invoke any MCP tools.
   */
  getToolCallRecords(): ToolCallRecord[] {
    if (this.toolCallRecords.size === 0) return [];
    return Array.from(this.toolCallRecords.values()).map((r) => ({
      id: r.id,
      name: r.name,
      server_label: r.server_label,
      arguments: r.arguments,
      status: r.status,
      output: r.output,
      error: r.error,
      duration_ms: r.duration_ms,
      approval_request_id: r.approval_request_id,
    }));
  }
}
