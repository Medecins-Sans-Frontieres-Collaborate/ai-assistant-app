import {
  buildActiveFileTextBlock,
  selectFilesForBudget,
} from '@/lib/utils/server/chat/activeFiles';

import { OpenAIVisionModelID } from '@/types/openai';

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

    // Add indicator if model likely lacks vision support
    let enrichedMessages = context.messages;
    const isVisionModel = Object.values(OpenAIVisionModelID).includes(
      context.modelId as OpenAIVisionModelID,
    );
    if (!isVisionModel && imageFiles.length > 0) {
      const indicator = `Active images referenced (${imageFiles.length}). Current model may not support vision.`;
      const last = enrichedMessages[enrichedMessages.length - 1];
      if (typeof last.content === 'string') {
        enrichedMessages = enrichedMessages.slice(0, -1).concat({
          ...last,
          content: `${last.content}\n\n${indicator}`,
        });
      } else if (Array.isArray(last.content)) {
        enrichedMessages = enrichedMessages.slice(0, -1).concat({
          ...last,
          content: [...last.content, { type: 'text', text: indicator } as any],
        } as any);
      }
    }

    return {
      ...context,
      systemPrompt: enrichedSystemPrompt,
      enrichedMessages,
    };
  }
}
