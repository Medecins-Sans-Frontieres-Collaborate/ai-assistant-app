import {
  buildActiveFileTextBlock,
  selectFilesForBudget,
} from '@/lib/utils/server/chat/activeFiles';

import { OpenAIVisionModelID } from '@/types/openai';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import {
  ACTIVE_FILE_PIN_TOKEN_LIMIT,
  ACTIVE_FILE_SESSION_QUOTA,
} from '@/lib/constants/activeFileQuotas';

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

    // Server backstop: strip pinned flag from files exceeding pin token limit
    const sanitizedFiles = activeFiles.map((f) => {
      if (
        f.pinned &&
        f.processedContent?.tokenEstimate &&
        f.processedContent.tokenEstimate > ACTIVE_FILE_PIN_TOKEN_LIMIT
      ) {
        return { ...f, pinned: false };
      }
      return f;
    });

    // Session quota enforcement
    const usedSoFar = context.activeFilesTokensUsed ?? 0;
    const quota = context.activeFilesSessionQuota ?? ACTIVE_FILE_SESSION_QUOTA;
    const remaining = quota - usedSoFar;

    if (remaining <= 0) {
      console.warn(
        '[ActiveFileInjector] Session quota exhausted, skipping file injection',
      );
      return { ...context, activeFilesTokensConsumedThisTurn: 0 };
    }

    // Apply budget selection with session quota cap
    const budgetTokens = 2000;
    const effectiveBudget = Math.min(budgetTokens, remaining);
    const selected = selectFilesForBudget(sanitizedFiles, effectiveBudget);

    // Calculate tokens consumed this turn
    const tokensConsumedThisTurn = selected.reduce(
      (sum, f) => sum + (f.processedContent?.tokenEstimate ?? 0),
      0,
    );

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
    let messagesModified = false;
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
        messagesModified = true;
      } else if (Array.isArray(last.content)) {
        enrichedMessages = enrichedMessages.slice(0, -1).concat({
          ...last,
          content: [...last.content, { type: 'text', text: indicator } as any],
        } as any);
        messagesModified = true;
      }
    }

    return {
      ...context,
      systemPrompt: enrichedSystemPrompt,
      // Only overwrite enrichedMessages when we actually modified them;
      // otherwise downstream stages would treat an unchanged pass-through as
      // "enrichers wrote messages" and skip processedContent injection.
      ...(messagesModified ? { enrichedMessages } : {}),
      activeFilesTokensConsumedThisTurn: tokensConsumedThisTurn,
    };
  }
}
