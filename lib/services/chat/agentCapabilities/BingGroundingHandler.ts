import { appendMetadataToStream } from '@/lib/utils/app/metadata';

import { AgentCapabilities } from '@/types/agent';

import {
  BaseCapabilityHandler,
  BaseStreamState,
} from './BaseCapabilityHandler';

/**
 * State for tracking Bing grounding stream processing.
 *
 * Extends base state with citation tracking and marker buffering.
 */
interface BingGroundingState extends BaseStreamState {
  /** Collected citations with their metadata */
  citations: Array<{
    number: number;
    title: string;
    url: string;
    date: string;
  }>;

  /** Next citation number to assign */
  citationIndex: number;

  /** Maps citation markers to assigned numbers */
  citationMap: Map<string, number>;

  /**
   * Buffer for accumulating text to handle citation markers split across chunks.
   *
   * Azure agents return citations like 【3:0†source】 which may span multiple
   * text chunks. We buffer text until we can safely process complete markers.
   */
  markerBuffer: string;
}

/**
 * Handles streaming for agents with Bing grounding (web search).
 *
 * Responsibilities:
 * - Process text deltas from thread.message.delta events
 * - Handle citation markers (【3:0†source】) by buffering and replacing
 * - Extract URL citations from thread.message.completed annotations
 * - Append citation metadata at stream end
 *
 * Citation marker format from Azure:
 * - Short: 【3:0†source】 (just the word "source")
 * - Long: 【3:0†Title†URL】 (embedded title and URL)
 *
 * These are replaced with sequential numbers [1], [2], etc.
 */
export class BingGroundingHandler extends BaseCapabilityHandler {
  readonly name = 'BingGroundingHandler';

  /**
   * Handles all agents that don't have Code Interpreter enabled.
   * Bing grounding is the default capability for Azure AI Foundry agents.
   */
  canHandle(capabilities: AgentCapabilities | undefined): boolean {
    // Handle if Code Interpreter is NOT enabled (Bing grounding is the default)
    return !capabilities?.codeInterpreter?.enabled;
  }

  protected initializeState(baseState: BaseStreamState): BaseStreamState {
    const state: BingGroundingState = {
      ...baseState,
      citations: [],
      citationIndex: 1,
      citationMap: new Map(),
      markerBuffer: '',
    };
    return state;
  }

  protected async handleEvent(
    event: unknown,
    controller: ReadableStreamDefaultController,
    baseState: BaseStreamState,
  ): Promise<void> {
    const state = baseState as BingGroundingState;
    const eventMessage = event as { event: string; data: unknown };

    switch (eventMessage.event) {
      case 'thread.message.delta':
        this.handleMessageDelta(eventMessage.data, controller, state);
        break;

      case 'thread.message.completed':
        this.handleMessageCompleted(eventMessage.data, state);
        break;

      case 'thread.run.completed':
        this.handleRunCompleted(controller, state);
        break;

      case 'error':
        controller.error(
          new Error(`Agent error: ${JSON.stringify(eventMessage.data)}`),
        );
        break;

      case 'done':
        controller.close();
        break;
    }
  }

  /**
   * Processes text delta events, handling citation markers.
   */
  private handleMessageDelta(
    data: unknown,
    controller: ReadableStreamDefaultController,
    state: BingGroundingState,
  ): void {
    const messageData = data as {
      delta?: {
        content?: Array<{
          type: string;
          text?: { value: string };
        }>;
      };
    };

    if (
      !messageData?.delta?.content ||
      !Array.isArray(messageData.delta.content)
    ) {
      return;
    }

    for (const contentPart of messageData.delta.content) {
      if (contentPart.type !== 'text' || !contentPart.text?.value) {
        continue;
      }

      const textChunk = contentPart.text.value;

      // Stage 1: Accumulate text in marker buffer
      state.markerBuffer += textChunk;

      // Stage 2: Process complete citation markers in accumulated buffer
      //
      // Azure agents return citations in two formats:
      // - Short: 【3:0†source】 (just the word "source")
      // - Long:  【3:0†Title†URL】 (embedded title and URL)
      //
      // Regex breakdown: /【(\d+):(\d+)†[^】]+】/g
      // - 【        : Opening bracket (Chinese left lenticular bracket)
      // - (\d+)    : First number (source index)
      // - :        : Literal colon
      // - (\d+)    : Second number (sub-index)
      // - †        : Dagger symbol separator
      // - [^】]+   : Any characters except closing bracket
      // - 】       : Closing bracket (Chinese right lenticular bracket)
      //
      // Each unique marker gets a sequential number [1], [2], etc.
      const processedBuffer = state.markerBuffer.replace(
        /【(\d+):(\d+)†[^】]+】/g,
        (match: string) => {
          if (!state.citationMap.has(match)) {
            state.citationMap.set(match, state.citationIndex);
            state.citationIndex++;
          }
          return `[${state.citationMap.get(match)}]`;
        },
      );

      // Stage 3: Check for incomplete markers at end of buffer
      // If there's an opening bracket without a closing one, keep it in buffer
      const lastOpenBracket = processedBuffer.lastIndexOf('【');
      const lastCloseBracket = processedBuffer.lastIndexOf('】');

      if (lastOpenBracket > lastCloseBracket) {
        // Incomplete marker at end - keep it in buffer, send the rest
        const completeText = processedBuffer.slice(0, lastOpenBracket);
        if (completeText) {
          this.enqueueText(controller, state, completeText);
        }
        state.markerBuffer = processedBuffer.slice(lastOpenBracket);
      } else {
        // All markers complete - send everything
        this.enqueueText(controller, state, processedBuffer);
        state.markerBuffer = '';
      }
    }
  }

  /**
   * Extracts citation metadata from message completion annotations.
   */
  private handleMessageCompleted(
    data: unknown,
    state: BingGroundingState,
  ): void {
    const messageData = data as {
      content?: Array<{
        text?: {
          annotations?: Array<{
            type: string;
            text?: string;
            urlCitation?: { title?: string; url?: string };
          }>;
        };
      }>;
    };

    const annotations = messageData?.content?.[0]?.text?.annotations;
    if (!annotations) {
      return;
    }

    // Build a map from citation marker to annotation
    const markerToAnnotation = new Map<
      string,
      { title?: string; url?: string }
    >();

    for (const annotation of annotations) {
      if (
        annotation.type === 'url_citation' &&
        annotation.text &&
        annotation.urlCitation
      ) {
        markerToAnnotation.set(annotation.text, annotation.urlCitation);
      }
    }

    // Build citations list based on citationMap order
    // This ensures inline numbers match the citation list
    state.citations = [];
    for (const [marker, number] of state.citationMap.entries()) {
      const urlCitation = markerToAnnotation.get(marker);
      // Always add citation even if annotation is missing
      state.citations.push({
        number: number,
        title: urlCitation?.title || `Source ${number}`,
        url: urlCitation?.url || '',
        date: '',
      });

      if (!urlCitation) {
        console.warn(
          `[BingGroundingHandler] No annotation found for marker ${marker}, using placeholder`,
        );
      }
    }
  }

  /**
   * Finalizes the stream with metadata.
   */
  private handleRunCompleted(
    controller: ReadableStreamDefaultController,
    state: BingGroundingState,
  ): void {
    // Flush any remaining marker buffer
    if (state.markerBuffer) {
      this.enqueueText(controller, state, state.markerBuffer);
      state.markerBuffer = '';
    }

    // Append metadata at the very end
    appendMetadataToStream(controller, {
      citations: state.citations.length > 0 ? state.citations : undefined,
      threadId: state.context.isNewThread ? state.context.thread.id : undefined,
    });
  }
}
