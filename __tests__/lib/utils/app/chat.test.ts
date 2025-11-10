import {
  checkIsModelValid,
  isFileConversation,
  isImageConversation,
} from '@/lib/utils/app/chat';

import { Message } from '@/types/chat';
import { OpenAIModelID, OpenAIVisionModelID } from '@/types/openai';

import { describe, expect, it } from 'vitest';

describe('Chat Utilities', () => {
  describe('isImageConversation', () => {
    it('should return true when last message contains image_url', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image_url',
              image_url: {
                url: 'https://example.com/image.jpg',
                detail: 'auto',
              },
            },
          ],
          messageType: undefined,
        },
      ];

      expect(isImageConversation(messages)).toBe(true);
    });

    it('should return true when last message has multiple images', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these images' },
            {
              type: 'image_url',
              image_url: {
                url: 'https://example.com/image1.jpg',
                detail: 'auto',
              },
            },
            {
              type: 'image_url',
              image_url: {
                url: 'https://example.com/image2.jpg',
                detail: 'auto',
              },
            },
          ],
          messageType: undefined,
        },
      ];

      expect(isImageConversation(messages)).toBe(true);
    });

    it('should return false when message content is string', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: 'Just a text message',
          messageType: undefined,
        },
      ];

      expect(isImageConversation(messages)).toBe(false);
    });

    it('should return false when message content is array without image_url', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Just text content' }],
          messageType: undefined,
        },
      ];

      expect(isImageConversation(messages)).toBe(false);
    });

    it('should check only the last message in conversation', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First message' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/old.jpg', detail: 'auto' },
            },
          ],
          messageType: undefined,
        },
        {
          role: 'assistant',
          content: 'I see an image',
          messageType: undefined,
        },
        {
          role: 'user',
          content: 'Now just text',
          messageType: undefined,
        },
      ];

      expect(isImageConversation(messages)).toBe(false);
    });

    it('should handle single message conversation with image', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: 'https://example.com/image.jpg',
                detail: 'auto',
              },
            },
          ],
          messageType: undefined,
        },
      ];

      expect(isImageConversation(messages)).toBe(true);
    });

    it('should return false for empty messages array', () => {
      const messages: Message[] = [];

      // The function should handle empty arrays gracefully
      expect(isImageConversation(messages)).toBe(false);
    });
  });

  describe('isFileConversation', () => {
    it('should return true when last message contains file_url', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this file' },
            { type: 'file_url', url: 'https://example.com/document.pdf' },
          ],
          messageType: undefined,
        },
      ];

      expect(isFileConversation(messages)).toBe(true);
    });

    it('should return false when message content is string', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: 'Just text',
          messageType: undefined,
        },
      ];

      expect(isFileConversation(messages)).toBe(false);
    });

    it('should return false when message content is array without file_url', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Just text content' }],
          messageType: undefined,
        },
      ];

      expect(isFileConversation(messages)).toBe(false);
    });

    it('should check only the last message in conversation', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First message' },
            { type: 'file_url', url: 'https://example.com/old.pdf' },
          ],
          messageType: undefined,
        },
        {
          role: 'assistant',
          content: 'I analyzed the file',
          messageType: undefined,
        },
        {
          role: 'user',
          content: 'Now just text',
          messageType: undefined,
        },
      ];

      expect(isFileConversation(messages)).toBe(false);
    });

    it('should handle file and text together', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Please summarize this document' },
            { type: 'file_url', url: 'https://example.com/report.docx' },
          ],
          messageType: undefined,
        },
      ];

      expect(isFileConversation(messages)).toBe(true);
    });

    it('should return false when message has image_url instead of file_url', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this' },
            {
              type: 'image_url',
              image_url: {
                url: 'https://example.com/image.jpg',
                detail: 'auto',
              },
            },
          ],
          messageType: undefined,
        },
      ];

      expect(isFileConversation(messages)).toBe(false);
    });
  });

  describe('checkIsModelValid', () => {
    describe('OpenAI Models', () => {
      it('should return true for valid GPT-5 model', () => {
        expect(checkIsModelValid('gpt-5', OpenAIModelID)).toBe(true);
      });

      it('should return true for valid GPT-5 Chat model', () => {
        expect(checkIsModelValid('gpt-5-chat', OpenAIModelID)).toBe(true);
      });

      it('should return true for valid o3 model', () => {
        expect(checkIsModelValid('o3', OpenAIModelID)).toBe(true);
      });

      it('should return true for valid DeepSeek model', () => {
        expect(checkIsModelValid('DeepSeek-R1', OpenAIModelID)).toBe(true);
      });

      it('should return true for valid Grok model', () => {
        expect(checkIsModelValid('grok-3', OpenAIModelID)).toBe(true);
      });

      it('should return false for invalid model', () => {
        expect(checkIsModelValid('invalid-model', OpenAIModelID)).toBe(false);
      });

      it('should return false for empty string', () => {
        expect(checkIsModelValid('', OpenAIModelID)).toBe(false);
      });

      it('should return false for old model names', () => {
        expect(checkIsModelValid('gpt-4o', OpenAIModelID)).toBe(false);
      });
    });

    describe('Vision Models', () => {
      it('should return true for GPT-5 with vision capabilities', () => {
        expect(checkIsModelValid('gpt-5', OpenAIVisionModelID)).toBe(true);
      });

      it('should return true for Grok with vision capabilities', () => {
        expect(checkIsModelValid('grok-3', OpenAIVisionModelID)).toBe(true);
      });

      it('should return false for non-vision model', () => {
        expect(checkIsModelValid('DeepSeek-R1', OpenAIVisionModelID)).toBe(
          false,
        );
      });

      it('should return false for invalid vision model', () => {
        expect(checkIsModelValid('invalid-vision', OpenAIVisionModelID)).toBe(
          false,
        );
      });
    });

    describe('Error handling', () => {
      it('should return false for model not in the provided enum', () => {
        const customEnum = { CUSTOM_MODEL: 'custom-model' };

        expect(checkIsModelValid('gpt-4', customEnum)).toBe(false);
      });

      it('should handle special characters in model ID', () => {
        expect(checkIsModelValid('gpt-4-@#$%', OpenAIModelID)).toBe(false);
      });

      it('should be case-sensitive', () => {
        expect(checkIsModelValid('GPT-5', OpenAIModelID)).toBe(false);
        expect(checkIsModelValid('gpt-5', OpenAIModelID)).toBe(true);
      });
    });

    describe('Edge cases', () => {
      it('should handle model IDs with similar prefixes', () => {
        // gpt-5 vs gpt-5-chat
        expect(checkIsModelValid('gpt-5', OpenAIModelID)).toBe(true);
        expect(checkIsModelValid('gpt-5-chat', OpenAIModelID)).toBe(true);
      });

      it('should not match partial model IDs', () => {
        expect(checkIsModelValid('gpt-5-fake', OpenAIModelID)).toBe(false);
        expect(checkIsModelValid('gpt', OpenAIModelID)).toBe(false);
      });
    });
  });

  describe('Integration scenarios', () => {
    it('should correctly identify image conversation workflow', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this chart' },
            {
              type: 'image_url',
              image_url: {
                url: 'https://example.com/chart.png',
                detail: 'auto',
              },
            },
          ],
          messageType: undefined,
        },
      ];

      const isImage = isImageConversation(messages);
      const isFile = isFileConversation(messages);

      expect(isImage).toBe(true);
      expect(isFile).toBe(false);
    });

    it('should correctly identify file conversation workflow', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarize this PDF' },
            { type: 'file_url', url: 'https://example.com/document.pdf' },
          ],
          messageType: undefined,
        },
      ];

      const isImage = isImageConversation(messages);
      const isFile = isFileConversation(messages);

      expect(isImage).toBe(false);
      expect(isFile).toBe(true);
    });

    it('should correctly identify text-only conversation', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: 'Just a regular text question',
          messageType: undefined,
        },
      ];

      const isImage = isImageConversation(messages);
      const isFile = isFileConversation(messages);

      expect(isImage).toBe(false);
      expect(isFile).toBe(false);
    });

    it('should validate model for image conversation', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image_url',
              image_url: {
                url: 'https://example.com/image.jpg',
                detail: 'auto',
              },
            },
          ],
          messageType: undefined,
        },
      ];

      const isImage = isImageConversation(messages);
      const modelId = 'gpt-5';
      const isValidStandard = checkIsModelValid(modelId, OpenAIModelID);
      const isValidVision = checkIsModelValid(modelId, OpenAIVisionModelID);

      expect(isImage).toBe(true);
      expect(isValidStandard).toBe(true);
      expect(isValidVision).toBe(true); // gpt-5 supports vision
    });
  });
});
