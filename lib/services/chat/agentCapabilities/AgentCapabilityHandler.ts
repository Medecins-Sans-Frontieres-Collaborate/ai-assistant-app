import { AgentCapabilities } from '@/types/agent';
import { CodeInterpreterFile } from '@/types/codeInterpreter';

/**
 * Context passed to capability handlers for stream creation.
 *
 * Contains all information needed to process the agent stream,
 * including thread state and any uploaded files for the execution.
 */
export interface AgentStreamContext {
  /** Thread information */
  thread: { id: string };

  /** Whether this is a newly created thread */
  isNewThread: boolean;

  /** Timestamp when the request started (for duration tracking) */
  startTime: number;

  /** Files uploaded for Code Interpreter (when applicable) */
  uploadedFiles?: CodeInterpreterFile[];
}

/**
 * Interface for agent capability handlers.
 *
 * Each capability (Bing grounding, Code Interpreter, file search, etc.)
 * implements this interface to provide isolated stream processing logic.
 *
 * The pattern follows Chain of Responsibility principles - handlers check
 * if they can handle the given capabilities and process the stream accordingly.
 */
export interface AgentCapabilityHandler {
  /** Handler name for logging and debugging */
  readonly name: string;

  /**
   * Determines if this handler should process the stream.
   *
   * @param capabilities - The agent capabilities enabled for this execution
   * @returns true if this handler should process the stream
   */
  canHandle(capabilities: AgentCapabilities | undefined): boolean;

  /**
   * Creates a ReadableStream that processes agent events.
   *
   * The stream transforms raw agent events into properly formatted
   * text output with embedded metadata (citations, file references, etc.).
   *
   * @param streamEventMessages - Async iterator of events from Azure AI Agents SDK
   * @param context - Execution context (thread info, uploaded files, etc.)
   * @returns ReadableStream that emits processed text chunks
   */
  createStream(
    streamEventMessages: AsyncIterable<unknown>,
    context: AgentStreamContext,
  ): ReadableStream;
}
