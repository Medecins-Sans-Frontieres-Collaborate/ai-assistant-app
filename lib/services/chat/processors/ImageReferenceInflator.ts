import { getBlobBase64String } from '@/lib/utils/server/blob/blob';

import { ImageMessageContent, Message } from '@/types/chat';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

/**
 * Walks every message in the request and inflates any `image_url` whose URL
 * is not already a `data:` URL into a base64 data URL via
 * `getBlobBase64String`.
 *
 * Why this exists: `ImageProcessor` and `FileProcessor` only touch the *last*
 * message. Older-turn pinned images therefore arrive at model handlers as
 * `/api/file/{id}` URLs that the LLM API cannot fetch. Doing the inflation
 * server-side here lets the client send small URL refs in the request body
 * — keeping JSON payloads well under the 10 MB cap — while still giving the
 * model the full base64 it needs.
 *
 * Idempotent: any `image_url` already starting with `data:` is left alone.
 * On per-image failure the original URL is passed through and a warning
 * logged, so one missing/permission-denied image doesn't blank out the rest.
 */
export class ImageReferenceInflator extends BasePipelineStage {
  readonly name = 'ImageReferenceInflator';

  shouldRun(context: ChatContext): boolean {
    return context.messages.some(messageHasUrlImage);
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const userId = context.user?.id ?? 'anonymous';

    let inflated = 0;
    let failed = 0;

    const newMessages = await Promise.all(
      context.messages.map(async (msg) => {
        if (!Array.isArray(msg.content)) return msg;
        if (!messageHasUrlImage(msg)) return msg;

        const newContent = await Promise.all(
          msg.content.map(async (item) => {
            if (!isUrlImage(item)) return item;
            try {
              const filename = extractFilename(item.image_url.url);
              const base64Url = await getBlobBase64String(
                userId,
                filename,
                'images',
                context.user,
              );
              inflated++;
              return {
                ...item,
                image_url: { ...item.image_url, url: base64Url },
              };
            } catch (err) {
              failed++;
              console.warn(
                `[ImageReferenceInflator] Failed to inflate image ` +
                  `"${item.image_url.url}": ${
                    err instanceof Error ? err.message : String(err)
                  }`,
              );
              return item;
            }
          }),
        );

        return { ...msg, content: newContent as Message['content'] };
      }),
    );

    console.log(
      `[ImageReferenceInflator] Inflated ${inflated} image(s)` +
        (failed > 0 ? `, ${failed} failed` : ''),
    );

    return { ...context, messages: newMessages };
  }
}

function isUrlImage(item: unknown): item is ImageMessageContent {
  if (!item || typeof item !== 'object') return false;
  const obj = item as { type?: unknown; image_url?: { url?: unknown } };
  if (obj.type !== 'image_url') return false;
  const url = obj.image_url?.url;
  return typeof url === 'string' && !url.startsWith('data:');
}

function messageHasUrlImage(msg: Message): boolean {
  return Array.isArray(msg.content) && msg.content.some(isUrlImage);
}

function extractFilename(url: string): string {
  return url.split('/').pop() || url;
}
