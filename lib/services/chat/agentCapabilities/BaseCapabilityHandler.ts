import { createStreamEncoder } from '@/lib/utils/app/metadata';

import { AgentCapabilities } from '@/types/agent';

import {
  AgentCapabilityHandler,
  AgentStreamContext,
} from './AgentCapabilityHandler';

/**
 * State object for tracking stream processing.
 *
 * Subclasses extend this with capability-specific state.
 */
export interface BaseStreamState {
  /** Text encoder for stream output */
  encoder: TextEncoder;

  /** Execution context */
  context: AgentStreamContext;

  /** Whether an error has occurred */
  hasError: boolean;

  /** Error message if hasError is true */
  errorMessage?: string;
}

/**
 * Abstract base class for agent capability handlers.
 *
 * Provides common infrastructure for stream processing:
 * - Encoder initialization
 * - Event loop structure
 * - Error handling
 * - State management
 *
 * Subclasses implement the capability-specific event handling logic.
 */
export abstract class BaseCapabilityHandler implements AgentCapabilityHandler {
  abstract readonly name: string;

  abstract canHandle(capabilities: AgentCapabilities | undefined): boolean;

  /**
   * Creates a ReadableStream that processes agent events.
   *
   * Implements the template method pattern - the overall structure is fixed,
   * but subclasses customize initialization, event handling, and finalization.
   *
   * @param streamEventMessages - Async iterator of events from Azure AI Agents SDK
   * @param context - Execution context
   * @returns ReadableStream emitting processed text chunks
   */
  createStream(
    streamEventMessages: AsyncIterable<unknown>,
    context: AgentStreamContext,
  ): ReadableStream {
    // Bind methods to preserve 'this' context in ReadableStream callbacks
    const initializeState = this.initializeState.bind(this);
    const handleEvent = this.handleEvent.bind(this);
    const handleError = this.handleError.bind(this);

    return new ReadableStream({
      async start(controller) {
        const encoder = createStreamEncoder();
        const baseState: BaseStreamState = {
          encoder,
          context,
          hasError: false,
        };

        // Let subclass initialize additional state
        const state = initializeState(baseState);

        try {
          for await (const event of streamEventMessages) {
            await handleEvent(event, controller, state);
          }
        } catch (error) {
          handleError(error, controller, state);
        }
      },
    });
  }

  /**
   * Initializes state for stream processing.
   *
   * Subclasses should extend the base state with capability-specific fields.
   *
   * @param baseState - Base state with encoder and context
   * @returns Extended state object for this capability
   */
  protected abstract initializeState(
    baseState: BaseStreamState,
  ): BaseStreamState;

  /**
   * Handles a single event from the stream.
   *
   * Called for each event in the stream. Subclasses implement
   * capability-specific event handling logic.
   *
   * @param event - Event from Azure AI Agents SDK
   * @param controller - Stream controller for enqueuing output
   * @param state - Current processing state
   */
  protected abstract handleEvent(
    event: unknown,
    controller: ReadableStreamDefaultController,
    state: BaseStreamState,
  ): Promise<void>;

  /**
   * Handles errors during stream processing.
   *
   * Default implementation logs the error and signals controller error.
   * Subclasses can override for capability-specific error handling.
   *
   * @param error - The error that occurred
   * @param controller - Stream controller
   * @param state - Current processing state
   */
  protected handleError(
    error: unknown,
    controller: ReadableStreamDefaultController,
    state: BaseStreamState,
  ): void {
    state.hasError = true;
    state.errorMessage = error instanceof Error ? error.message : String(error);
    controller.error(error);
  }

  /**
   * Utility method to enqueue text to the stream.
   *
   * @param controller - Stream controller
   * @param state - Current state with encoder
   * @param text - Text to enqueue
   */
  protected enqueueText(
    controller: ReadableStreamDefaultController,
    state: BaseStreamState,
    text: string,
  ): void {
    controller.enqueue(state.encoder.encode(text));
  }
}
