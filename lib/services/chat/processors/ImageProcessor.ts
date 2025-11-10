import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

/**
 * ImageProcessor handles image content in the pipeline.
 *
 * Responsibilities:
 * - Validates that images are accessible
 * - Extracts image URLs for later use
 * - NO processing needed (OpenAI supports images natively)
 *
 * Modifies context:
 * - context.processedContent.images
 *
 * Note: Images are handled natively by OpenAI's vision models.
 * This processor just ensures they're extracted and validated.
 */
export class ImageProcessor extends BasePipelineStage {
  readonly name = 'ImageProcessor';

  shouldRun(context: ChatContext): boolean {
    // Only run if images are present AND no files
    // (If files are present, FileProcessor handles images too)
    return context.hasImages && !context.hasFiles;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const lastMessage = context.messages[context.messages.length - 1];

    if (!Array.isArray(lastMessage.content)) {
      throw new Error('Expected array content for image processing');
    }

    const images: Array<{ url: string; detail: 'auto' | 'low' | 'high' }> = [];

    // Extract images from message
    for (const section of lastMessage.content) {
      if (section.type === 'image_url') {
        images.push({
          url: section.image_url.url,
          detail: section.image_url.detail || 'auto',
        });
      }
    }

    console.log(`[ImageProcessor] Found ${images.length} image(s)`);

    // Note: Image URL validation is not performed here.
    // OpenAI's API will handle invalid URLs gracefully with error responses.
    // Future enhancement: Pre-validate URLs to fail fast, but not required.

    return {
      ...context,
      processedContent: {
        ...context.processedContent,
        images: images.length > 0 ? images : undefined,
      },
    };
  }
}
