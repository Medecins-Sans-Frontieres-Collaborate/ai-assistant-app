import { sanitizeForLog } from '@/lib/utils/server/logSanitization';

import { ErrorCode, ErrorSeverity, PipelineError } from '@/lib/types/errors';

import { ChatContext } from './ChatContext';
import { PipelineStage } from './PipelineStage';

/**
 * Timeout configuration for pipeline stages (in milliseconds).
 * Per-stage timeouts prevent one slow stage from consuming all available time.
 *
 * If a stage exceeds its timeout:
 * - A warning is added to context.errors
 * - The stage is skipped gracefully
 * - Pipeline continues with next stage
 */
const STAGE_TIMEOUTS: Record<string, number> = {
  FileProcessor: 30000, // 30s for file download/processing
  ImageProcessor: 5000, // 5s for image validation
  RAGEnricher: 10000, // 10s for knowledge base search
  ToolRouterEnricher: 45000, // 45s for web search (AI agent + Bing search + result processing)
  AgentEnricher: 5000, // 5s for agent selection
  StandardChatHandler: 90000, // 90s for LLM response (reasoning models can take longer)
  AgentChatHandler: 120000, // 120s for agent execution
};

/**
 * Default timeout for stages not explicitly configured.
 */
const DEFAULT_STAGE_TIMEOUT = 30000; // 30s

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
   * @returns The final chat context after all stages
   */
  async execute(initialContext: ChatContext): Promise<ChatContext> {
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

        try {
          context = await Promise.race([
            stage.execute(context),
            this.createTimeoutPromise(timeout, stage.name),
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

            // Continue to next stage (graceful degradation)
            continue;
          }

          // Re-throw non-timeout errors
          throw error;
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
  ): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
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
  }
}
