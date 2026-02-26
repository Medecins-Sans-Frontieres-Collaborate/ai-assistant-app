import {
  ParsedMetadata,
  PendingTranscriptionInfo,
  createStreamDecoder,
  parseMetadataFromContent,
} from '@/lib/utils/app/metadata';

import { Message, MessageType } from '@/types/chat';
import { Citation } from '@/types/rag';

/**
 * Handles parsing of streaming chat responses
 * Extracts metadata (citations, transcripts, actions) and display content
 */
export class StreamParser {
  private text: string = '';
  private extractedCitations: Citation[] = [];
  private extractedThreadId?: string;
  private extractedTranscript?: any;
  private extractedPendingTranscriptions?: PendingTranscriptionInfo[];
  private extractedFileCacheUpdates?: Array<{
    fileId: string;
    processedContent: any;
  }>;
  private hasReceivedContent: boolean = false;
  private prevDisplayText: string = '';
  private prevCitationsStr: string = '[]';

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
  } {
    const chunk = this.decoder.decode(value, options);
    this.text += chunk;

    const parsed = parseMetadataFromContent(this.text);
    const displayText = parsed.content;

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
    if ((parsed as any).fileCacheUpdates && !this.extractedFileCacheUpdates) {
      this.extractedFileCacheUpdates = (parsed as any).fileCacheUpdates;
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
      action: parsed.action,
      contentChanged,
      citationsChanged,
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
  getTranscript(): any | undefined {
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
  getFileCacheUpdates():
    | Array<{ fileId: string; processedContent: any }>
    | undefined {
    return this.extractedFileCacheUpdates;
  }

  /**
   * Check if any content has been received
   */
  getHasReceivedContent(): boolean {
    return this.hasReceivedContent;
  }
}
