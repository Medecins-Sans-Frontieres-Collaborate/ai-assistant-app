import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

/**
 * Processes active files that don't have cached content.
 *
 * Placeholder implementation: detects pending files and returns context unchanged.
 * Future work: download/extract content, populate processedContent, emit SSE updates.
 */
export class ActiveFileProcessor extends BasePipelineStage {
  readonly name = 'ActiveFileProcessor';

  shouldRun(context: ChatContext): boolean {
    const files = context.activeFiles ?? [];
    return files.some((f) => f.status !== 'ready' || !f.processedContent);
  }

  // No-op for now; hook for future content extraction and cache updates
  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    return context;
  }
}
