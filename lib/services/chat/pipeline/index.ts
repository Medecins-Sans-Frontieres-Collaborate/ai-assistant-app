/**
 * Chat Pipeline System
 *
 * Unified pipeline architecture for processing all types of chat requests.
 *
 * Components:
 * - ChatContext: Shared state for the entire request
 * - Middleware: Build initial context (auth, parsing, analysis)
 * - PipelineStage: Interface for all pipeline stages
 * - ChatPipeline: Orchestrates stage execution
 *
 * Usage:
 * ```typescript
 * const context = await buildChatContext(req);
 * const pipeline = new ChatPipeline([...stages]);
 * const result = await pipeline.execute(context);
 * return result.response;
 * ```
 */

export type { ChatContext, ProcessedContent } from './ChatContext';
export type { PipelineStage } from './PipelineStage';
export { BasePipelineStage } from './PipelineStage';
export { ChatPipeline } from './ChatPipeline';
export type { Middleware } from './Middleware';
export {
  applyMiddleware,
  buildChatContext,
  authMiddleware,
  createRateLimitMiddleware,
  requestParsingMiddleware,
  createContentAnalysisMiddleware,
  createModelSelectionMiddleware,
} from './Middleware';
