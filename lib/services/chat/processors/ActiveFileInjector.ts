import {
  buildActiveFileTextBlock,
  selectFilesForBudget,
} from '@/lib/utils/server/chat/activeFiles';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

/**
 * Injects active file content into the system prompt and/or messages.
 */
export class ActiveFileInjector extends BasePipelineStage {
  readonly name = 'ActiveFileInjector';

  shouldRun(context: ChatContext): boolean {
    return (context.activeFiles?.length ?? 0) > 0;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const activeFiles = context.activeFiles ?? [];

    // Apply simple budget selection (placeholder)
    const selected = selectFilesForBudget(activeFiles);

    // Separate images from text-like files
    const imageFiles = selected.filter(
      (f) => f.processedContent?.type === 'image',
    );
    const textFiles = selected.filter(
      (f) => f.processedContent?.type !== 'image',
    );

    // Build text block for system prompt
    const textBlock = buildActiveFileTextBlock(textFiles, {
      redactFilenames: false,
    });

    const enrichedSystemPrompt =
      textBlock.trim().length > 0
        ? `${context.systemPrompt}\n\n${textBlock}`
        : context.systemPrompt;

    // For now, do not modify messages for images
    const enrichedMessages = context.messages;

    return {
      ...context,
      systemPrompt: enrichedSystemPrompt,
      enrichedMessages,
    };
  }
}
