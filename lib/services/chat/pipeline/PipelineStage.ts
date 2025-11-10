import { ChatContext } from './ChatContext';

/**
 * PipelineStage represents a single stage in the chat processing pipeline.
 *
 * Stages can be:
 * - Content Processors: Process file/audio/image content
 * - Feature Enrichers: Add RAG, search, agent capabilities
 * - Execution Handlers: Execute the final chat request
 *
 * Each stage:
 * 1. Checks if it should run (shouldRun)
 * 2. Executes its logic (execute)
 * 3. Modifies the ChatContext
 * 4. Returns the modified context
 *
 * Stages are composable and order-independent (within their category).
 */
export interface PipelineStage {
  /**
   * Name of this stage (for logging and debugging).
   */
  readonly name: string;

  /**
   * Determines if this stage should run for the given context.
   *
   * @param context - The current chat context
   * @returns true if this stage should execute, false to skip
   *
   * @example
   * shouldRun(context: ChatContext): boolean {
   *   return context.hasFiles;
   * }
   */
  shouldRun(context: ChatContext): boolean;

  /**
   * Executes this stage's logic.
   *
   * Should:
   * - Read from context
   * - Perform processing
   * - Modify context with results
   * - Return modified context
   *
   * Must NOT:
   * - Throw errors (catch and add to context.errors)
   * - Mutate services
   * - Have side effects outside context
   *
   * @param context - The current chat context
   * @returns The modified chat context
   *
   * @example
   * async execute(context: ChatContext): Promise<ChatContext> {
   *   const result = await this.process(context.messages);
   *   return {
   *     ...context,
   *     processedContent: result,
   *   };
   * }
   */
  execute(context: ChatContext): Promise<ChatContext>;
}

/**
 * Base implementation of PipelineStage with common functionality.
 *
 * Provides:
 * - Error handling
 * - Performance tracking
 * - Logging
 *
 * Subclasses only need to implement shouldRun() and executeStage().
 */
export abstract class BasePipelineStage implements PipelineStage {
  abstract readonly name: string;

  abstract shouldRun(context: ChatContext): boolean;

  /**
   * Template method that handles error handling and metrics.
   * Subclasses implement executeStage() instead.
   */
  async execute(context: ChatContext): Promise<ChatContext> {
    const startTime = Date.now();

    try {
      console.log(`[Pipeline] Executing stage: ${this.name}`);

      const result = await this.executeStage(context);

      const duration = Date.now() - startTime;
      console.log(`[Pipeline] Stage ${this.name} completed in ${duration}ms`);

      // Track metrics
      if (!result.metrics) {
        result.metrics = {
          startTime: context.metrics?.startTime || Date.now(),
        };
      }
      if (!result.metrics.stageTimings) {
        result.metrics.stageTimings = new Map();
      }
      result.metrics.stageTimings.set(this.name, duration);

      return result;
    } catch (error) {
      console.error(`[Pipeline] Stage ${this.name} failed:`, error);

      // Add error to context instead of throwing
      const errors = context.errors || [];
      errors.push(
        error instanceof Error
          ? error
          : new Error(`Stage ${this.name} failed: ${String(error)}`),
      );

      return {
        ...context,
        errors,
      };
    }
  }

  /**
   * Subclasses implement this method with their stage logic.
   *
   * @param context - The current chat context
   * @returns The modified chat context
   */
  protected abstract executeStage(context: ChatContext): Promise<ChatContext>;
}
