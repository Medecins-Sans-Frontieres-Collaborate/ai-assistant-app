import { getBlobBase64String } from '@/lib/utils/server/blob/blob';
import {
  buildActiveFileTextBlock,
  computeActiveFilePerTurnBudget,
  selectFilesForBudget,
} from '@/lib/utils/server/chat/activeFiles';
import { IMAGE_TOKENS_HIGH_DETAIL } from '@/lib/utils/server/chat/chat';

import { ActiveFile, ImageMessageContent } from '@/types/chat';
import { OpenAIVisionModelID } from '@/types/openai';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { getActiveFileBudgets } from '@/lib/constants/activeFileQuotas';

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
    const budgets = getActiveFileBudgets(context.model);

    // Server backstop: strip pinned flag from files exceeding the tier's
    // pin token limit. The client may have pinned at upload time under a
    // different model selection.
    const sanitizedFiles = activeFiles.map((f) => {
      if (
        f.pinned &&
        f.processedContent?.tokenEstimate &&
        f.processedContent.tokenEstimate > budgets.pinLimit
      ) {
        return { ...f, pinned: false };
      }
      return f;
    });

    // Session quota enforcement
    const usedSoFar = context.activeFilesTokensUsed ?? 0;
    const quota = context.activeFilesSessionQuota ?? budgets.sessionQuota;
    const remaining = quota - usedSoFar;

    if (remaining <= 0) {
      console.warn(
        '[ActiveFileInjector] Session quota exhausted, skipping file injection',
      );
      return {
        ...context,
        activeFilesTokensConsumedThisTurn: 0,
        activeFilesDroppedThisTurn: sanitizedFiles.map((f) => f.id),
      };
    }

    // Apply budget selection with session quota cap. The per-turn ceiling
    // scales with the model's context window so modern 128k/200k models get
    // the headroom they can support, while legacy models stay at the floor.
    const budgetTokens = computeActiveFilePerTurnBudget(context.model);
    const effectiveBudget = Math.min(budgetTokens, remaining);
    const { selected, dropped } = selectFilesForBudget(
      sanitizedFiles,
      effectiveBudget,
    );

    // Stamp lastUsedAt on selected files so the next turn's selection sort
    // reflects actual usage. Without this, lastUsedAt is only ever set at
    // first processing and selection order is permanently locked to upload
    // order — which silently freezes the same files in context turn after
    // turn and never lets a dropped file rotate back in.
    const nowIso = new Date().toISOString();
    const selectedIds = new Set(selected.map((f) => f.id));
    const updatedActiveFiles = sanitizedFiles.map((f) =>
      selectedIds.has(f.id) ? { ...f, lastUsedAt: nowIso } : f,
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

    // Image handling: vision-capable models can have *pinned* images
    // re-injected into the last user message; non-vision models get a text
    // indicator so the model still knows there were images.
    //
    // Anthropic caveat: AnthropicHandler currently strips all image content
    // from messages before forwarding (see AnthropicHandler.ts). So while
    // this stage will still append image_url blocks for Claude models that
    // are in OpenAIVisionModelID, the handler will drop them at request
    // time. Reviving Anthropic image support is a follow-up — it requires a
    // converter for Anthropic's distinct content-block schema (`{type:
    // 'image', source: {type: 'base64', media_type, data}}`).
    let enrichedMessages = context.messages;
    let messagesModified = false;
    let imageTokenCost = 0;
    const isVisionModel = Object.values(OpenAIVisionModelID).includes(
      context.modelId as OpenAIVisionModelID,
    );
    const reinjectionEnabled = context.autoInjectPinnedImages !== false;
    const pinnedImageFiles = imageFiles.filter((f) => f.pinned);

    if (isVisionModel && reinjectionEnabled && pinnedImageFiles.length > 0) {
      const injectedBlocks = await this.buildImageBlocks(
        pinnedImageFiles,
        context,
      );
      if (injectedBlocks.length > 0) {
        // Token cost is per *successfully resolved* injection, not per
        // attempted one — fetches that fail just don't get billed.
        imageTokenCost = injectedBlocks.length * IMAGE_TOKENS_HIGH_DETAIL;
        const last = enrichedMessages[enrichedMessages.length - 1];
        const newContent =
          typeof last.content === 'string'
            ? [{ type: 'text', text: last.content } as any, ...injectedBlocks]
            : Array.isArray(last.content)
              ? [...last.content, ...injectedBlocks]
              : null;
        if (newContent) {
          enrichedMessages = enrichedMessages.slice(0, -1).concat({
            ...last,
            content: newContent,
          } as any);
          messagesModified = true;
        }
      }
    } else if (!isVisionModel && imageFiles.length > 0) {
      // Non-vision model: keep the text indicator regardless of the
      // re-injection setting (the setting only governs vision injection;
      // for non-vision models there's no way to forward the image, and
      // suppressing the indicator would hide that an image was ever pinned).
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

    // Calculate tokens consumed this turn (text files + injected images).
    // Image cost uses the IMAGE_TOKENS_HIGH_DETAIL fixed estimate (765),
    // which under-counts large 'high'-detail images and is rough on
    // Anthropic's dimension-based pricing — exact accounting is not the
    // goal, fairness against text-file pins is.
    const textFileTokens = textFiles.reduce(
      (sum, f) => sum + (f.processedContent?.tokenEstimate ?? 0),
      0,
    );
    const tokensConsumedThisTurn = textFileTokens + imageTokenCost;

    return {
      ...context,
      activeFiles: updatedActiveFiles,
      systemPrompt: enrichedSystemPrompt,
      // Only overwrite enrichedMessages when we actually modified them;
      // otherwise downstream stages would treat an unchanged pass-through as
      // "enrichers wrote messages" and skip processedContent injection.
      ...(messagesModified ? { enrichedMessages } : {}),
      activeFilesTokensConsumedThisTurn: tokensConsumedThisTurn,
      activeFilesDroppedThisTurn: dropped.map((f) => f.id),
    };
  }

  /**
   * Resolve pinned image active files into `image_url` content blocks with
   * their URL inlined as a base64 data URL.
   *
   * The standard chat handler replaces `image_url.url` from
   * `context.processedContent.images` *by index* — so re-injected blocks
   * appended *after* the ImageProcessor stage runs would otherwise leave
   * `/api/file/{id}` references in the outgoing payload (LLM APIs cannot
   * fetch private blob URLs). Resolving here keeps the injector
   * self-contained and avoids the index-coupling.
   *
   * Failed fetches are skipped (logged once each) rather than aborting the
   * whole turn — a vision-capable conversation should still proceed if one
   * pinned image is unreachable.
   */
  private async buildImageBlocks(
    pinnedImages: ActiveFile[],
    context: ChatContext,
  ): Promise<ImageMessageContent[]> {
    const blocks: ImageMessageContent[] = [];
    for (const file of pinnedImages) {
      try {
        const url = file.url;
        const resolvedUrl = url.startsWith('data:')
          ? url
          : await getBlobBase64String(
              context.user.id ?? 'anonymous',
              url.split('/').pop() || url,
              'images',
              context.user,
            );
        blocks.push({
          type: 'image_url',
          image_url: { url: resolvedUrl, detail: 'auto' },
        });
      } catch (err) {
        console.warn(
          `[ActiveFileInjector] Skipping re-injection of pinned image ${file.id} (${file.originalFilename}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return blocks;
  }
}
