import {
  PendingTranscriptionInfo,
  StreamMetadata,
  TokenUsageMetadata,
  TranscriptMetadata,
  createStreamDecoder,
  parseMetadataFromContent,
  pendingMetadataStartIndex,
} from '@/lib/utils/app/metadata';

import {
  ExtractionResultContent,
  Message,
  MessageType,
  ToolCallRecord,
} from '@/types/chat';
import { Citation } from '@/types/rag';

import {
  AgentActivityPayload,
  ConsentOutcomePayload,
  ConsentRequestPayload,
  SearchInterimPayload,
  ToolCallRecordPayload,
  scanStreamEvents,
  stripIncompleteStreamMarkers,
} from '@/lib/streamMarkers';

/**
 * A stream that ENDED CLEANLY but carried a server-reported failure in its
 * terminal metadata (`streamError`). Distinct from a network-level abort:
 * the server chose to finish the response, so partial tool records and
 * consent state are intact — the store surfaces the failure with that
 * context and must NOT silently retry on a fallback model, UNLESS the
 * server set `retry` (the partial is a broken promise, e.g. a missing
 * generated file — retrying is strictly better than keeping it).
 */
export class StreamInterruptedError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    /**
     * Server marked the partial output as not worth keeping (e.g. it
     * promises a generated file that was never delivered) — the store
     * SHOULD auto-retry on the fallback chain for this one.
     */
    public readonly retry: boolean = false,
  ) {
    super(message);
    this.name = 'StreamInterruptedError';
  }
}

/**
 * Parses streaming chat responses. Forward-only: each chunk scans only
 * the suffix past `processedIndex`, so total work is O(stream_size) and
 * not O(stream_size²).
 */
export class StreamParser {
  private text: string = '';
  /** Bytes before this index are either in `displayText` or were events. */
  private processedIndex: number = 0;
  /**
   * Set once a terminal metadata block has been seen, complete or partial.
   * Gates trailing-newline trimming so a metadata-free stream keeps any
   * newlines the model actually produced.
   */
  private sawMetadataBoundary: boolean = false;
  /** What the markdown renderer sees. Incomplete marker tails are excluded. */
  private displayText: string = '';
  private extractedCitations: Citation[] = [];
  private extractedThreadId?: string;
  private extractedThinking?: string;
  private extractedTranscript?: TranscriptMetadata;
  private extractedPendingTranscriptions?: PendingTranscriptionInfo[];
  private extractedFileCacheUpdates?: StreamMetadata['fileCacheUpdates'];
  private extractedActiveFilesTokensConsumed?: number;
  private extractedActiveFilesDropped?: string[];
  private extractedUsage?: TokenUsageMetadata;
  private extractedExtractionResult?: ExtractionResultContent;
  private extractedStreamError?: {
    message: string;
    code?: string;
    retry?: boolean;
  };
  private extractedMcpPlan?: import('@/types/mcp').McpPlan;
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
  // Interim headlines from a combined search (latest emission wins).
  private latestSearchInterim: SearchInterimPayload | null = null;

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
    /** Whether interim search headlines arrived/changed this chunk. */
    searchInterimChanged: boolean;
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
    } else {
      // The block has only PARTIALLY arrived (split across network reads):
      // parseMetadataFromContent reports no index until it sees the closing
      // marker, so without this the half-marker flushes into displayText —
      // and because processedIndex is monotonic, it can never be taken back.
      // Hold those bytes until the rest of the block lands.
      const pendingMeta = pendingMetadataStartIndex(this.text);
      if (pendingMeta !== -1) {
        scanEnd = Math.min(scanEnd, pendingMeta);
      }
    }
    // Once we know a metadata block exists, any trailing newlines in the
    // display text are its `\n\n` separator, never content — the separator
    // itself can be split across reads, so its first `\n` may already have
    // flushed before the marker became recognizable.
    if (parsed.metadataStartIndex != null || scanEnd < this.text.length) {
      this.sawMetadataBoundary = true;
    }
    const scanInput =
      scanEnd === this.text.length ? this.text : this.text.slice(0, scanEnd);
    const scan = scanStreamEvents(scanInput, this.processedIndex);

    const newOutcomes: ConsentOutcomePayload[] = [];
    let consentChanged = false;
    let toolCallsChanged = false;
    let searchInterimChanged = false;
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
        case 'search_interim': {
          this.latestSearchInterim = event.payload;
          searchInterimChanged = true;
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
    let renderedDisplayText = this.displayText.replace(
      /\n*\s*(?:\[\d+\]\s*)+\s*$/g,
      '',
    );
    if (this.sawMetadataBoundary) {
      renderedDisplayText = renderedDisplayText.replace(/\n+$/, '');
    }

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

    // Capture reasoning/thinking from the terminal metadata block (only once)
    if (parsed.thinking && !this.extractedThinking) {
      this.extractedThinking = parsed.thinking;
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

    // Capture per-request token usage if present (terminal metadata block)
    if (parsed.usage && this.extractedUsage == null) {
      this.extractedUsage = parsed.usage;
    }

    // Capture a server-reported mid-stream failure (terminal metadata).
    if (parsed.streamError && !this.extractedStreamError) {
      this.extractedStreamError = parsed.streamError;
    }

    // Capture the MCP turn plan (echoed back on approval resume).
    if (parsed.mcpPlan && !this.extractedMcpPlan) {
      this.extractedMcpPlan = parsed.mcpPlan;
    }

    // Capture structured-extraction result if present. When set, this
    // replaces the assistant message's `content` — text-body is empty on
    // an extraction turn, so the message renders entirely from the
    // datasets carried here.
    if (parsed.extractionResult && !this.extractedExtractionResult) {
      this.extractedExtractionResult = parsed.extractionResult;
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
      searchInterimChanged,
    };
  }

  /** Consent prompts seen so far, in arrival order. */
  getConsentRequests(): ConsentRequestPayload[] {
    return this.consentRequests;
  }

  /** Latest interim headlines from a combined search, if any arrived. */
  getSearchInterim(): SearchInterimPayload | null {
    return this.latestSearchInterim;
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
    let finalText = this.prevDisplayText;
    if (!finalText.trim()) {
      // Raw-accumulator fallback, needed for non-streaming JSON bodies. It
      // must never surface wire format: a stream that carried ONLY markers
      // and/or a metadata block (e.g. a tool-loop failure reported after
      // activity markers) has an empty display text, not raw sentinels.
      const parsed = parseMetadataFromContent(this.text);
      finalText = stripIncompleteStreamMarkers(
        scanStreamEvents(parsed.content, 0).displayDelta,
      ).trim();
    }
    if (finalText.trim().startsWith('{') && finalText.trim().endsWith('}')) {
      try {
        const jsonResponse = JSON.parse(finalText);
        if (jsonResponse.text) {
          finalText = jsonResponse.text;
        }
        // Non-streaming bodies carry usage inline instead of via metadata
        if (jsonResponse.usage && this.extractedUsage == null) {
          this.extractedUsage = jsonResponse.usage as TokenUsageMetadata;
        }
        // Non-streaming Anthropic bodies carry thinking inline too
        if (
          typeof jsonResponse.thinking === 'string' &&
          jsonResponse.thinking &&
          !this.extractedThinking
        ) {
          this.extractedThinking = jsonResponse.thinking;
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
    // If an extraction result was emitted, the assistant message is the
    // structured payload itself — not the streamed text body.
    if (this.extractedExtractionResult) {
      return {
        role: 'assistant',
        content: this.extractedExtractionResult,
        messageType: MessageType.TEXT,
      };
    }

    return {
      role: 'assistant',
      content,
      messageType: MessageType.TEXT,
      citations:
        this.extractedCitations.length > 0
          ? this.extractedCitations
          : undefined,
      transcript: this.extractedTranscript,
      thinking: this.extractedThinking,
      mcpPlan: this.extractedMcpPlan,
    };
  }

  /**
   * The MCP turn plan from the terminal metadata block, for the client to
   * persist on the message and echo back on approval resume.
   */
  getMcpPlan(): import('@/types/mcp').McpPlan | undefined {
    return this.extractedMcpPlan;
  }

  /**
   * Get the extraction result if one was emitted on the stream.
   */
  getExtractionResult(): ExtractionResultContent | undefined {
    return this.extractedExtractionResult;
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
   * Reasoning/thinking text reported via the terminal metadata block (or
   * inline `thinking` on non-streaming JSON bodies via finalize()).
   */
  getThinking(): string | undefined {
    return this.extractedThinking;
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
   * Get the per-request token usage reported by the server (terminal
   * metadata block for streams, inline `usage` for non-streaming JSON).
   */
  getUsage(): TokenUsageMetadata | undefined {
    return this.extractedUsage;
  }

  /**
   * Server-reported mid-stream failure, if the stream ended cleanly with a
   * `streamError` metadata block. Callers surface it as an error state even
   * though the HTTP stream itself completed.
   */
  getStreamError():
    | { message: string; code?: string; retry?: boolean }
    | undefined {
    return this.extractedStreamError;
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
      ...(r.generated_files ? { generated_files: r.generated_files } : {}),
    }));
  }
}
