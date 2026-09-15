import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';
import { ErrorCode, ErrorSeverity, PipelineError } from '@/types/errors';

import { ChatContext } from './ChatContext';
import { PipelineStage } from './PipelineStage';

/** Union of all possible message content types */
type MessageContent =
  | TextMessageContent
  | ImageMessageContent
  | FileMessageContent;

/**
 * Timeout configuration for pipeline stages (in milliseconds).
 * Per-stage timeouts prevent one slow stage from consuming all available time.
 *
 * If a stage exceeds its timeout:
 * - A warning is added to context.errors
 * - The stage is skipped gracefully
 * - Pipeline continues with next stage
 */
export const STAGE_TIMEOUTS: Record<string, number> = {
  FileProcessor: 180000, // 180s (3 min) for large file download + extraction + processing
  ImageProcessor: 5000, // 5s for image validation
  RAGEnricher: 10000,
  // Reformulation LLM + query embedding + hybrid search over the shared
  // m365-agents index.
  M365AgentEnricher: 20000, // 20s for knowledge base search
  // Web search (reasoning agent + Bing grounding) and the document-trim
  // pipeline (LLM edit plan + sandbox execution + one bounded corrective
  // pass) both run long; 240s leaves the route's 300s ceiling room for
  // FileProcessor extraction and time-to-first-byte of the model answer.
  ToolRouterEnricher: 240000,
  AgentEnricher: 5000, // 5s for agent selection
  StandardChatHandler: 90000, // 90s for LLM response (reasoning models can take longer)
  AgentChatHandler: 120000, // 120s for agent execution
};

/**
 * Default timeout for stages not explicitly configured.
 */
const DEFAULT_STAGE_TIMEOUT = 30000; // 30s

/**
 * The stages whose timeout is the user-facing "model timeout" (issue #130):
 * both resolve when the model's response STARTS (the handler returns a
 * Response whose body is piped afterwards, untimed), so their timer is the
 * time-to-first-byte bound the user is actually tuning.
 */
export const MODEL_HANDLER_STAGES = [
  'StandardChatHandler',
  'AgentChatHandler',
] as const;

export function isModelHandlerStage(stageName: unknown): boolean {
  return (
    typeof stageName === 'string' &&
    (MODEL_HANDLER_STAGES as readonly string[]).includes(stageName)
  );
}

/**
 * Per-request stage timeouts: the compiled defaults with the model handler
 * stages overridden by the user's (already clamped) model timeout. Absent
 * → the defaults, byte-identical to the pre-#130 behavior.
 *
 * StandardChatHandler takes the user's value as-is (that IS the model
 * timeout). AgentChatHandler can only be LENGTHENED: its 120 s default
 * also covers Foundry thread/run setup, and since every current client
 * sends a timeout (90 s by default), honouring a lower value there would
 * have silently cut agent turns from 120 s to 90 s for everyone.
 */
export function resolveStageTimeouts(
  modelTimeoutMs: number | undefined,
): Record<string, number> {
  if (modelTimeoutMs === undefined) return STAGE_TIMEOUTS;
  return {
    ...STAGE_TIMEOUTS,
    StandardChatHandler: modelTimeoutMs,
    AgentChatHandler: Math.max(STAGE_TIMEOUTS.AgentChatHandler, modelTimeoutMs),
  };
}

/**
 * ChatPipeline orchestrates the execution of pipeline stages.
 *
 * Responsibilities:
 * - Executes stages in order
 * - Skips stages that shouldn't run
 * - Enforces per-stage timeouts (prevents timeout starvation)
 * - Handles errors gracefully
 * - Tracks performance metrics
 * - Provides debugging information
 *
 * Usage:
 * ```typescript
 * const pipeline = new ChatPipeline([
 *   new FileProcessor(...),
 *   new RAGEnricher(...),
 *   new StandardChatHandler(...),
 * ]);
 *
 * const result = await pipeline.execute(context);
 * ```
 */
export class ChatPipeline {
  constructor(
    private stages: PipelineStage[],
    private stageTimeouts: Record<string, number> = STAGE_TIMEOUTS,
  ) {}

  /**
   * Executes all pipeline stages in order.
   *
   * Flow:
   * 1. For each stage:
   *    a. Check if it should run
   *    b. If yes, execute it
   *    c. Pass modified context to next stage
   * 2. Return final context
   *
   * Error Handling:
   * - Errors are caught and added to context.errors
   * - Pipeline continues (fail-fast is opt-in per stage)
   * - Final context includes all errors
   *
   * @param initialContext - The initial chat context
   * @param options.signal - Request-level cancellation (the route's
   *   whole-request guard). When it fires, the running stage's own signal
   *   is aborted with the same reason and no further stage runs — so a
   *   caller that has already reported a timeout never has a model call
   *   start (and bill) behind its back.
   * @returns The final chat context after all stages
   */
  async execute(
    initialContext: ChatContext,
    options: { signal?: AbortSignal } = {},
  ): Promise<ChatContext> {
    const startTime = Date.now();
    let context: ChatContext = {
      ...initialContext,
      // Respect existing metrics from middleware, don't overwrite
      metrics: initialContext.metrics || {
        startTime,
        stageTimings: new Map(),
      },
    };

    console.log('[Pipeline] Starting execution with stages:', {
      stageCount: this.stages.length,
      stageNames: this.stages.map((s) => s.name),
    });

    for (const stage of this.stages) {
      if (options.signal?.aborted) {
        console.warn(
          `[Pipeline] Request aborted before stage ${stage.name}; stopping`,
        );
        break;
      }
      try {
        // Check if stage should run
        const shouldRun = stage.shouldRun(context);

        if (!shouldRun) {
          console.log(`[Pipeline] Skipping stage: ${stage.name}`);
          continue;
        }

        // Get timeout for this stage
        const timeout = this.stageTimeouts[stage.name] || DEFAULT_STAGE_TIMEOUT;

        // Execute stage with timeout
        console.log(
          `[Pipeline] Running stage: ${stage.name} (timeout: ${timeout}ms)`,
        );

        const errorCountBefore = context.errors?.length ?? 0;
        // Aborted when THIS stage loses the race below, or when the
        // request-level signal fires while it runs. A stage that returned
        // in time is never aborted afterwards: the await's continuation (a
        // microtask) clears the timer and drops the request listener before
        // the timer's macrotask could ever run.
        const stageAbort = new AbortController();
        const onRequestAbort = () => stageAbort.abort(options.signal?.reason);
        options.signal?.addEventListener('abort', onRequestAbort, {
          once: true,
        });
        const { promise: timeoutPromise, cancel: cancelTimeout } =
          this.createTimeoutPromise(timeout, stage.name, stageAbort);
        try {
          context = await Promise.race([
            stage.execute({ ...context, stageSignal: stageAbort.signal }),
            timeoutPromise,
          ]);
        } catch (error) {
          // Check if this is a timeout error
          if (
            error instanceof PipelineError &&
            error.code === ErrorCode.PIPELINE_TIMEOUT
          ) {
            console.warn(
              `[Pipeline] Stage ${stage.name} timed out after ${timeout}ms, skipping gracefully`,
            );

            // Add timeout warning to errors
            const errors = context.errors || [];
            errors.push(error);
            context = { ...context, errors };

            // Stage-specific degradation on the pre-stage context (the
            // timed-out execution's result is discarded).
            if (typeof stage.onTimeout === 'function') {
              try {
                context = stage.onTimeout(context);
              } catch (hookError) {
                console.error(
                  `[Pipeline] onTimeout hook of ${stage.name} failed:`,
                  hookError instanceof Error ? hookError.message : hookError,
                );
              }
            }

            if (stage.name === 'FileProcessor') {
              context = this.handleFileProcessorFailure(context, 'timed out');
            }

            // Continue to next stage (graceful degradation)
            continue;
          }

          // Re-throw non-timeout errors
          throw error;
        } finally {
          cancelTimeout();
          options.signal?.removeEventListener('abort', onRequestAbort);
        }

        if (
          stage.name === 'FileProcessor' &&
          (context.errors?.length ?? 0) > errorCountBefore
        ) {
          context = this.handleFileProcessorFailure(context, 'failed');
        }

        // Check for critical errors that should stop the pipeline
        if (context.errors && context.errors.length > 0) {
          const criticalError = context.errors.find(
            (e) =>
              e instanceof PipelineError &&
              e.severity === ErrorSeverity.CRITICAL,
          );
          if (criticalError) {
            console.error(
              `[Pipeline] Critical error in stage ${stage.name}, stopping pipeline:`,
              sanitizeForLog(criticalError),
            );
            break;
          }
        }
      } catch (error) {
        // Stage execution threw an error that wasn't caught
        console.error(
          `[Pipeline] Uncaught error in stage ${stage.name}:`,
          sanitizeForLog(error),
        );

        // Add to errors
        const errors = context.errors || [];
        errors.push(
          error instanceof Error
            ? error
            : new Error(`Uncaught error in ${stage.name}: ${String(error)}`),
        );
        context = { ...context, errors };

        // Special handling for FileProcessor failures:
        // Remove file_url content from messages to prevent Azure OpenAI errors
        if (stage.name === 'FileProcessor') {
          context = this.handleFileProcessorFailure(context, 'failed');
        }

        // Continue to next stage
      }
    }

    // Finalize metrics
    const endTime = Date.now();
    context.metrics = {
      ...context.metrics,
      startTime,
      endTime,
    };

    const totalTime = endTime - startTime;
    console.log('[Pipeline] Execution completed:', {
      totalTime: `${totalTime}ms`,
      stagesRun: Array.from(context.metrics.stageTimings?.keys() || []),
      errorCount: context.errors?.length || 0,
    });

    return context;
  }

  /**
   * Returns the list of stages in this pipeline.
   * Useful for debugging and testing.
   */
  getStages(): readonly PipelineStage[] {
    return [...this.stages];
  }

  /**
   * Returns the names of all stages.
   * Useful for logging and debugging.
   */
  getStageNames(): string[] {
    return this.stages.map((s) => s.name);
  }

  /**
   * Creates a timeout promise that rejects after the specified duration.
   * Used to enforce per-stage timeouts.
   *
   * @param timeoutMs - Timeout duration in milliseconds
   * @param stageName - Name of the stage (for error messaging)
   * @returns Promise that rejects with PipelineError after timeout
   */
  private createTimeoutPromise(
    timeoutMs: number,
    stageName: string,
    stageAbort?: AbortController,
  ): { promise: Promise<never>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Cancel the stage's upstream work (a model call that will never be
        // consumed) before the pipeline moves on without it.
        stageAbort?.abort(
          PipelineError.warning(
            ErrorCode.PIPELINE_TIMEOUT,
            `Stage ${stageName} exceeded timeout of ${timeoutMs}ms`,
            { stageName, timeoutMs },
          ),
        );
        reject(
          PipelineError.warning(
            ErrorCode.PIPELINE_TIMEOUT,
            `Stage ${stageName} exceeded timeout of ${timeoutMs}ms`,
            {
              stageName,
              timeoutMs,
            },
          ),
        );
      }, timeoutMs);
    });
    const cancel = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    return { promise, cancel };
  }

  /**
   * Logs and sanitizes file_url content after the FileProcessor stage fails
   * (whether it timed out, errored, or threw). `reason` is folded into the log
   * line so each failure mode stays distinguishable.
   */
  private handleFileProcessorFailure(
    context: ChatContext,
    reason: string,
  ): ChatContext {
    console.warn(
      `[Pipeline] FileProcessor ${reason}, sanitizing file_url content from messages`,
    );
    return this.sanitizeFileUrlsOnError(context);
  }

  /**
   * Sanitizes messages when FileProcessor fails to prevent file_url content
   * from reaching downstream handlers that don't support it.
   *
   * This ensures graceful degradation: the chat can continue without the file
   * content, with an informative message about the failure.
   *
   * @param context - The current chat context
   * @returns Updated context with sanitized messages
   */
  private sanitizeFileUrlsOnError(context: ChatContext): ChatContext {
    const sanitizedMessages: Message[] = context.messages.map((message) => {
      if (typeof message.content === 'string') {
        return message;
      }

      if (!Array.isArray(message.content)) {
        return message;
      }

      // Check if this message has file_url content
      const hasFileUrl = message.content.some(
        (c: MessageContent) => c.type === 'file_url',
      );

      if (!hasFileUrl) {
        return message;
      }

      // Filter out file_url content
      const sanitizedContent = message.content.filter(
        (c: MessageContent) => c.type !== 'file_url',
      );

      // Add notice about failed file processing
      const fileUrlCount = message.content.filter(
        (c: MessageContent) => c.type === 'file_url',
      ).length;

      const notice =
        fileUrlCount === 1
          ? '[Note: The uploaded file could not be processed]'
          : `[Note: ${fileUrlCount} uploaded files could not be processed]`;

      // Add notice to existing text content or create new text content
      const textContent = sanitizedContent.find(
        (c: MessageContent) => c.type === 'text',
      );
      if (textContent && 'text' in textContent) {
        (textContent as TextMessageContent).text =
          `${notice}\n\n${(textContent as TextMessageContent).text}`;
      } else {
        sanitizedContent.unshift({
          type: 'text',
          text: notice,
        } as TextMessageContent);
      }

      // If only text remains, convert to string
      if (
        sanitizedContent.length === 1 &&
        sanitizedContent[0].type === 'text' &&
        'text' in sanitizedContent[0]
      ) {
        return {
          ...message,
          content: (sanitizedContent[0] as TextMessageContent).text,
        };
      }

      return {
        ...message,
        content: sanitizedContent,
      };
    });

    return {
      ...context,
      messages: sanitizedMessages,
      processedContent: {
        ...context.processedContent,
        metadata: {
          ...context.processedContent?.metadata,
          fileProcessingFailed: true,
        },
      },
    };
  }
}
