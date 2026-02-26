import { ServiceContainer } from '@/lib/services/ServiceContainer';

import { countTokens } from '@/lib/utils/server/tiktoken/tiktokenCache';

import { ActiveFile } from '@/types/chat';

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

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const files = context.activeFiles ?? [];
    if (files.length === 0) return context;

    const container = ServiceContainer.getInstance();
    const fileService = container.getFileProcessingService();

    // Concurrency limiter
    const limit = 3;
    const queue: Promise<void>[] = [];
    const updates: Array<{
      fileId: string;
      processedContent: NonNullable<ActiveFile['processedContent']>;
    }> = [];
    const updatedFiles: ActiveFile[] = [...files];

    const isImage = (f: ActiveFile) =>
      (f.mimeType?.startsWith('image/') ?? false) ||
      /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.originalFilename);

    const processOne = async (file: ActiveFile) => {
      try {
        // Skip if image (handled as URL injection rather than text extraction)
        if (isImage(file)) return;

        // Skip if already processed
        if (file.processedContent && file.status === 'ready') return;

        const [blobId, tempPath] = fileService.getTempFilePath(file.url);

        // Prefer cached text if available
        await fileService.downloadFilePreferCached(
          file.url,
          tempPath,
          context.user,
        );
        const buffer = await fileService.readFile(tempPath);
        // Read as UTF-8 with cap to avoid memory blowups
        const text = buffer.toString('utf-8');

        const tokenEstimate = await countTokens(text);
        const processedContent = {
          type: 'document' as const,
          content: text,
          tokenEstimate,
          processedAt: new Date().toISOString(),
        };

        // Update local copy and queue SSE update
        const idx = updatedFiles.findIndex((f) => f.id === file.id);
        if (idx !== -1) {
          updatedFiles[idx] = {
            ...updatedFiles[idx],
            status: 'ready',
            processedContent,
            lastUsedAt: new Date().toISOString(),
          };
          updates.push({ fileId: file.id, processedContent });
        }

        // Cleanup temp file
        await fileService.cleanupFile(tempPath);
      } catch (e) {
        // Mark error state on failure
        const idx = updatedFiles.findIndex((f) => f.id === file.id);
        if (idx !== -1) {
          updatedFiles[idx] = {
            ...updatedFiles[idx],
            status: 'error',
            errorMessage: e instanceof Error ? e.message : String(e),
          };
        }
      }
    };

    for (const f of files) {
      if (queue.length >= limit) {
        await Promise.race(queue);
      }
      const p = processOne(f).finally(() => {
        const i = queue.indexOf(p);
        if (i >= 0) queue.splice(i, 1);
      });
      queue.push(p);
    }

    await Promise.all(queue);

    return {
      ...context,
      activeFiles: updatedFiles,
      activeFilesCacheUpdates: updates,
    };
  }
}
