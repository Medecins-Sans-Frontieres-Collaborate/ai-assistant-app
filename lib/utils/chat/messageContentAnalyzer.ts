import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';

/**
 * Content types that can be detected in a message
 */
export type ContentType = 'text' | 'image' | 'file' | 'audio' | 'video';

/**
 * Summary of content analysis
 */
export interface ContentSummary {
  types: Set<ContentType>;
  counts: {
    files: number;
    images: number;
    text: number;
  };
  isAudioVideo: boolean;
  hasText: boolean;
}

/**
 * Audio/video file extensions supported for transcription
 */
const AUDIO_VIDEO_EXTENSIONS = [
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.m4a',
  '.wav',
  '.webm',
];

/**
 * Centralized content analyzer for chat messages
 * Provides a single source of truth for content type detection and analysis
 */
export class MessageContentAnalyzer {
  private content: Message['content'];

  constructor(message: Message | Message['content']) {
    // Support both Message object and content directly
    this.content =
      typeof message === 'object' && message !== null && 'content' in message
        ? message.content
        : message;
  }

  /**
   * Check if the message contains file URLs
   */
  hasFiles(): boolean {
    if (!Array.isArray(this.content)) return false;
    return this.content.some((item) => item.type === 'file_url');
  }

  /**
   * Check if the message contains image URLs
   */
  hasImages(): boolean {
    if (!Array.isArray(this.content)) return false;
    return this.content.some((item) => item.type === 'image_url');
  }

  /**
   * Check if the message contains text content
   */
  hasText(): boolean {
    if (typeof this.content === 'string') return this.content.trim().length > 0;
    if (!Array.isArray(this.content)) {
      return (
        this.content.type === 'text' && this.content.text.trim().length > 0
      );
    }
    return this.content.some(
      (item) => item.type === 'text' && item.text?.trim().length > 0,
    );
  }

  /**
   * Check if the message contains audio or video files
   */
  hasAudio(): boolean {
    if (!Array.isArray(this.content)) return false;
    return this.content.some((item) => {
      if (item.type === 'file_url' && item.url) {
        const ext = '.' + item.url.split('.').pop()?.toLowerCase();
        return AUDIO_VIDEO_EXTENSIONS.includes(ext);
      }
      return false;
    });
  }

  /**
   * Get the count of files in the message
   */
  getFileCount(): number {
    if (!Array.isArray(this.content)) return 0;
    return this.content.filter((item) => item.type === 'file_url').length;
  }

  /**
   * Get the count of images in the message
   */
  getImageCount(): number {
    if (!Array.isArray(this.content)) return 0;
    return this.content.filter((item) => item.type === 'image_url').length;
  }

  /**
   * Get all content types present in the message
   * Returns a Set to handle mixed content properly
   */
  getContentTypes(): Set<ContentType> {
    const types = new Set<ContentType>();

    if (typeof this.content === 'string') {
      types.add('text');
      return types;
    }

    if (!Array.isArray(this.content)) {
      if (this.content.type === 'text') types.add('text');
      return types;
    }

    for (const item of this.content) {
      switch (item.type) {
        case 'text':
          types.add('text');
          break;
        case 'file_url': {
          const ext = '.' + item.url.split('.').pop()?.toLowerCase();
          if (AUDIO_VIDEO_EXTENSIONS.includes(ext)) {
            types.add('audio'); // or 'video' - we treat them the same
          } else {
            types.add('file');
          }
          break;
        }
        case 'image_url':
          types.add('image');
          break;
      }
    }

    return types;
  }

  /**
   * Get a comprehensive summary of the message content
   */
  getContentSummary(): ContentSummary {
    return {
      types: this.getContentTypes(),
      counts: {
        files: this.getFileCount(),
        images: this.getImageCount(),
        text: this.hasText() ? 1 : 0,
      },
      isAudioVideo: this.hasAudio(),
      hasText: this.hasText(),
    };
  }

  /**
   * Get an appropriate loading message based on content type
   * Used to show users what's being processed
   */
  getLoadingMessage(): string {
    const summary = this.getContentSummary();
    const { types, counts, isAudioVideo, hasText } = summary;

    // Audio/video transcription
    if (isAudioVideo) {
      return hasText
        ? 'Transcribing and processing...'
        : 'Transcribing audio...';
    }

    // Files
    if (types.has('file')) {
      // Mixed content (files + images)
      if (types.has('image')) {
        return 'Analyzing files...';
      }
      // Multiple documents
      if (counts.files > 1) {
        return 'Analyzing documents...';
      }
      // Single document
      return 'Analyzing document...';
    }

    // Images only
    if (types.has('image')) {
      return counts.images > 1 ? 'Analyzing images...' : 'Analyzing image...';
    }

    // Default
    return 'Thinking...';
  }

  /**
   * Extract text content from the message
   * Returns the first text item found or empty string
   */
  extractText(): string {
    if (typeof this.content === 'string') {
      return this.content;
    }

    if (!Array.isArray(this.content)) {
      return this.content.type === 'text' ? this.content.text : '';
    }

    const textContent = this.content.find(
      (item): item is TextMessageContent => item.type === 'text',
    ) as TextMessageContent | undefined;
    return textContent?.text ?? '';
  }

  /**
   * Extract all file URLs from the message
   */
  extractFileUrls(): FileMessageContent[] {
    if (!Array.isArray(this.content)) return [];
    return this.content.filter(
      (item): item is FileMessageContent => item.type === 'file_url',
    ) as FileMessageContent[];
  }

  /**
   * Extract all image URLs from the message
   */
  extractImageUrls(): ImageMessageContent[] {
    if (!Array.isArray(this.content)) return [];
    return this.content.filter(
      (item): item is ImageMessageContent => item.type === 'image_url',
    ) as ImageMessageContent[];
  }

  /**
   * Check if this is a simple text-only message
   */
  isSimpleText(): boolean {
    return typeof this.content === 'string';
  }

  /**
   * Check if this is a mixed content message (multiple types)
   */
  isMixedContent(): boolean {
    return this.getContentTypes().size > 1;
  }

  /**
   * Get a human-readable description of the content
   * Useful for debugging and logging
   */
  getContentDescription(): string {
    const summary = this.getContentSummary();
    const parts: string[] = [];

    if (summary.counts.text > 0) parts.push('text');
    if (summary.counts.images > 0)
      parts.push(`${summary.counts.images} image(s)`);
    if (summary.counts.files > 0) parts.push(`${summary.counts.files} file(s)`);
    if (summary.isAudioVideo) parts.push('audio/video');

    return parts.join(' + ') || 'empty';
  }
}

/**
 * Helper function to create an analyzer from a message
 */
export function analyzeMessage(message: Message): MessageContentAnalyzer {
  return new MessageContentAnalyzer(message);
}
