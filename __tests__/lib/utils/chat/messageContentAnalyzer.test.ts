import { MessageContentAnalyzer } from '@/lib/utils/chat/messageContentAnalyzer';

import { Message, MessageType } from '@/types/chat';

import { describe, expect, it } from 'vitest';

describe('MessageContentAnalyzer', () => {
  describe('Simple text messages', () => {
    it('should detect simple string content', () => {
      const message: Message = {
        role: 'user',
        content: 'Hello world',
        messageType: MessageType.TEXT,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.isSimpleText()).toBe(true);
      expect(analyzer.hasText()).toBe(true);
      expect(analyzer.hasFiles()).toBe(false);
      expect(analyzer.hasImages()).toBe(false);
      expect(analyzer.hasAudio()).toBe(false);
    });

    it('should extract text from simple message', () => {
      const message: Message = {
        role: 'user',
        content: 'Test content',
        messageType: MessageType.TEXT,
      };

      const analyzer = new MessageContentAnalyzer(message);
      expect(analyzer.extractText()).toBe('Test content');
    });

    it('should get correct loading message for text', () => {
      const message: Message = {
        role: 'user',
        content: 'Hello',
        messageType: MessageType.TEXT,
      };

      const analyzer = new MessageContentAnalyzer(message);
      expect(analyzer.getLoadingMessage()).toBe('Thinking...');
    });
  });

  describe('File messages', () => {
    it('should detect file content', () => {
      const message: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'Check this file' },
          {
            type: 'file_url',
            url: 'https://example.com/doc.pdf',
            originalFilename: 'doc.pdf',
          },
        ],
        messageType: MessageType.FILE,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.hasFiles()).toBe(true);
      expect(analyzer.hasImages()).toBe(false);
      expect(analyzer.hasAudio()).toBe(false);
      expect(analyzer.getFileCount()).toBe(1);
    });

    it('should handle multiple files', () => {
      const message: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'Check these files' },
          { type: 'file_url', url: 'https://example.com/doc1.pdf' },
          { type: 'file_url', url: 'https://example.com/doc2.pdf' },
          { type: 'file_url', url: 'https://example.com/doc3.pdf' },
        ],
        messageType: MessageType.FILE,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.getFileCount()).toBe(3);
      expect(analyzer.getLoadingMessage()).toBe('Analyzing documents...');
    });

    it('should detect single file correctly', () => {
      const message: Message = {
        role: 'user',
        content: [{ type: 'file_url', url: 'https://example.com/doc.pdf' }],
        messageType: MessageType.FILE,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.getFileCount()).toBe(1);
      expect(analyzer.getLoadingMessage()).toBe('Analyzing document...');
    });

    it('should extract file URLs', () => {
      const message: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'Files' },
          { type: 'file_url', url: 'https://example.com/doc1.pdf' },
          { type: 'file_url', url: 'https://example.com/doc2.pdf' },
        ],
        messageType: MessageType.FILE,
      };

      const analyzer = new MessageContentAnalyzer(message);
      const files = analyzer.extractFileUrls();

      expect(files).toHaveLength(2);
      expect(files[0].url).toBe('https://example.com/doc1.pdf');
      expect(files[1].url).toBe('https://example.com/doc2.pdf');
    });
  });

  describe('Image messages', () => {
    it('should detect image content', () => {
      const message: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img.jpg', detail: 'auto' },
          },
        ],
        messageType: MessageType.IMAGE,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.hasImages()).toBe(true);
      expect(analyzer.hasFiles()).toBe(false);
      expect(analyzer.getImageCount()).toBe(1);
    });

    it('should handle multiple images', () => {
      const message: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze these' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img1.jpg', detail: 'auto' },
          },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img2.jpg', detail: 'auto' },
          },
        ],
        messageType: MessageType.IMAGE,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.getImageCount()).toBe(2);
      expect(analyzer.getLoadingMessage()).toBe('Analyzing images...');
    });

    it('should detect single image correctly', () => {
      const message: Message = {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img.jpg', detail: 'auto' },
          },
        ],
        messageType: MessageType.IMAGE,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.getImageCount()).toBe(1);
      expect(analyzer.getLoadingMessage()).toBe('Analyzing image...');
    });

    it('should extract image URLs', () => {
      const message: Message = {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img1.jpg', detail: 'auto' },
          },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img2.jpg', detail: 'high' },
          },
        ],
        messageType: MessageType.IMAGE,
      };

      const analyzer = new MessageContentAnalyzer(message);
      const images = analyzer.extractImageUrls();

      expect(images).toHaveLength(2);
      expect(images[0].image_url.url).toBe('https://example.com/img1.jpg');
      expect(images[1].image_url.url).toBe('https://example.com/img2.jpg');
    });
  });

  describe('Audio/Video messages', () => {
    it('should detect audio files by extension (.mp3)', () => {
      const message: Message = {
        role: 'user',
        content: [{ type: 'file_url', url: 'https://example.com/audio.mp3' }],
        messageType: MessageType.AUDIO,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.hasAudio()).toBe(true);
      expect(analyzer.hasFiles()).toBe(true);
      expect(analyzer.getLoadingMessage()).toBe('Transcribing audio...');
    });

    it('should detect video files by extension (.mp4)', () => {
      const message: Message = {
        role: 'user',
        content: [{ type: 'file_url', url: 'https://example.com/video.mp4' }],
        messageType: MessageType.VIDEO,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.hasAudio()).toBe(true);
      expect(analyzer.getLoadingMessage()).toBe('Transcribing audio...');
    });

    it('should detect all audio extensions', () => {
      const extensions = [
        '.mp3',
        '.mp4',
        '.mpeg',
        '.mpga',
        '.m4a',
        '.wav',
        '.webm',
      ];

      extensions.forEach((ext) => {
        const message: Message = {
          role: 'user',
          content: [
            { type: 'file_url', url: `https://example.com/audio${ext}` },
          ],
          messageType: MessageType.AUDIO,
        };

        const analyzer = new MessageContentAnalyzer(message);
        expect(analyzer.hasAudio()).toBe(true);
      });
    });

    it('should show correct message when audio + text', () => {
      const message: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this' },
          { type: 'file_url', url: 'https://example.com/audio.mp3' },
        ],
        messageType: MessageType.AUDIO,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.hasText()).toBe(true);
      expect(analyzer.hasAudio()).toBe(true);
      expect(analyzer.getLoadingMessage()).toBe(
        'Transcribing and processing...',
      );
    });

    it('should not detect non-audio files as audio', () => {
      const message: Message = {
        role: 'user',
        content: [{ type: 'file_url', url: 'https://example.com/doc.pdf' }],
        messageType: MessageType.FILE,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.hasAudio()).toBe(false);
      expect(analyzer.hasFiles()).toBe(true);
    });
  });

  describe('Mixed content messages', () => {
    it('should detect mixed content (files + images)', () => {
      const message: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this' },
          { type: 'file_url', url: 'https://example.com/doc.pdf' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img.jpg', detail: 'auto' },
          },
        ],
        messageType: 'MULTI_FILE',
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.hasFiles()).toBe(true);
      expect(analyzer.hasImages()).toBe(true);
      expect(analyzer.isMixedContent()).toBe(true);
      expect(analyzer.getLoadingMessage()).toBe('Analyzing files...');
    });

    it('should get correct content types for mixed content', () => {
      const message: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'Test' },
          { type: 'file_url', url: 'https://example.com/doc.pdf' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img.jpg', detail: 'auto' },
          },
        ],
        messageType: 'MULTI_FILE',
      };

      const analyzer = new MessageContentAnalyzer(message);
      const types = analyzer.getContentTypes();

      expect(types.has('text')).toBe(true);
      expect(types.has('file')).toBe(true);
      expect(types.has('image')).toBe(true);
      expect(types.size).toBe(3);
    });
  });

  describe('Content summary', () => {
    it('should provide accurate summary for simple text', () => {
      const message: Message = {
        role: 'user',
        content: 'Hello',
        messageType: MessageType.TEXT,
      };

      const analyzer = new MessageContentAnalyzer(message);
      const summary = analyzer.getContentSummary();

      expect(summary.types.has('text')).toBe(true);
      expect(summary.counts.files).toBe(0);
      expect(summary.counts.images).toBe(0);
      expect(summary.hasText).toBe(true);
      expect(summary.isAudioVideo).toBe(false);
    });

    it('should provide accurate summary for mixed content', () => {
      const message: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze' },
          { type: 'file_url', url: 'https://example.com/doc.pdf' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img.jpg', detail: 'auto' },
          },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img2.jpg', detail: 'auto' },
          },
        ],
        messageType: 'MULTI_FILE',
      };

      const analyzer = new MessageContentAnalyzer(message);
      const summary = analyzer.getContentSummary();

      expect(summary.types.size).toBe(3); // text, file, image
      expect(summary.counts.files).toBe(1);
      expect(summary.counts.images).toBe(2);
      expect(summary.hasText).toBe(true);
      expect(summary.isAudioVideo).toBe(false);
    });
  });

  describe('Content description', () => {
    it('should describe simple text', () => {
      const message: Message = {
        role: 'user',
        content: 'Hello',
        messageType: MessageType.TEXT,
      };

      const analyzer = new MessageContentAnalyzer(message);
      expect(analyzer.getContentDescription()).toBe('text');
    });

    it('should describe file content', () => {
      const message: Message = {
        role: 'user',
        content: [{ type: 'file_url', url: 'https://example.com/doc.pdf' }],
        messageType: MessageType.FILE,
      };

      const analyzer = new MessageContentAnalyzer(message);
      expect(analyzer.getContentDescription()).toBe('1 file(s)');
    });

    it('should describe mixed content', () => {
      const message: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'Test' },
          { type: 'file_url', url: 'https://example.com/doc.pdf' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img.jpg', detail: 'auto' },
          },
        ],
        messageType: 'MULTI_FILE',
      };

      const analyzer = new MessageContentAnalyzer(message);
      const description = analyzer.getContentDescription();
      expect(description).toContain('text');
      expect(description).toContain('1 image(s)');
      expect(description).toContain('1 file(s)');
    });

    it('should describe audio/video content', () => {
      const message: Message = {
        role: 'user',
        content: [{ type: 'file_url', url: 'https://example.com/audio.mp3' }],
        messageType: MessageType.AUDIO,
      };

      const analyzer = new MessageContentAnalyzer(message);
      const description = analyzer.getContentDescription();
      expect(description).toContain('audio/video');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty text', () => {
      const message: Message = {
        role: 'user',
        content: '',
        messageType: MessageType.TEXT,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.hasText()).toBe(false);
      expect(analyzer.extractText()).toBe('');
    });

    it('should handle empty array content', () => {
      const message: Message = {
        role: 'user',
        content: [],
        messageType: undefined,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.hasFiles()).toBe(false);
      expect(analyzer.hasImages()).toBe(false);
      expect(analyzer.getFileCount()).toBe(0);
    });

    it('should handle whitespace-only text', () => {
      const message: Message = {
        role: 'user',
        content: '   \n\t  ',
        messageType: MessageType.TEXT,
      };

      const analyzer = new MessageContentAnalyzer(message);

      expect(analyzer.hasText()).toBe(false);
    });
  });

  describe('Direct content analysis (without Message wrapper)', () => {
    it('should work with string content directly', () => {
      const analyzer = new MessageContentAnalyzer('Hello world');

      expect(analyzer.isSimpleText()).toBe(true);
      expect(analyzer.extractText()).toBe('Hello world');
    });

    it('should work with array content directly', () => {
      const content = [
        { type: 'text' as const, text: 'Test' },
        { type: 'file_url' as const, url: 'https://example.com/doc.pdf' },
      ];

      const analyzer = new MessageContentAnalyzer(content);

      expect(analyzer.hasFiles()).toBe(true);
      expect(analyzer.extractText()).toBe('Test');
    });
  });
});
