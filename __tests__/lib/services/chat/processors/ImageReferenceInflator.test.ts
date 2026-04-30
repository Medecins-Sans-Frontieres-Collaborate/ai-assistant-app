import { ImageReferenceInflator } from '@/lib/services/chat/processors/ImageReferenceInflator';

import { getBlobBase64String } from '@/lib/utils/server/blob/blob';

import { Message } from '@/types/chat';

import { createTestChatContext } from '../testUtils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/utils/server/blob/blob', () => ({
  getBlobBase64String: vi.fn(),
}));

const mockGetBlob = vi.mocked(getBlobBase64String);

function userImage(url: string, text?: string): Message {
  const content: Message['content'] = [];
  if (text) content.push({ type: 'text', text });
  content.push({
    type: 'image_url',
    image_url: { url, detail: 'auto' },
  });
  return { role: 'user', content } as Message;
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: text } as Message;
}

describe('ImageReferenceInflator', () => {
  let stage: ImageReferenceInflator;

  beforeEach(() => {
    stage = new ImageReferenceInflator();
    mockGetBlob.mockReset();
  });

  describe('shouldRun', () => {
    it('returns true when an older message has a non-data: image URL', () => {
      const context = createTestChatContext({
        messages: [
          userImage('/api/file/old.png', 'old turn'),
          assistantText('seen'),
          { role: 'user', content: 'just text' } as Message,
        ],
      });
      expect(stage.shouldRun(context)).toBe(true);
    });

    it('returns false when every image is already inflated', () => {
      const context = createTestChatContext({
        messages: [
          userImage('data:image/png;base64,AAAA', 'old turn'),
          { role: 'user', content: 'just text' } as Message,
        ],
      });
      expect(stage.shouldRun(context)).toBe(false);
    });

    it('returns false when there are no images at all', () => {
      const context = createTestChatContext({
        messages: [
          { role: 'user', content: 'hello' } as Message,
          assistantText('hi'),
        ],
      });
      expect(stage.shouldRun(context)).toBe(false);
    });
  });

  describe('executeStage', () => {
    it('inflates image URLs in older turns (the regression we are fixing)', async () => {
      mockGetBlob.mockResolvedValue('data:image/png;base64,INFLATED');

      const context = createTestChatContext({
        hasImages: true,
        messages: [
          userImage('/api/file/photo1.png', 'see this'),
          assistantText('I see it'),
          userImage('/api/file/photo2.png', 'and this'),
          assistantText('seen'),
          { role: 'user', content: 'thoughts?' } as Message,
        ],
      });

      const result = await stage.execute(context);

      expect(mockGetBlob).toHaveBeenCalledTimes(2);
      expect(mockGetBlob).toHaveBeenCalledWith(
        'test-user-123',
        'photo1.png',
        'images',
        context.user,
      );
      expect(mockGetBlob).toHaveBeenCalledWith(
        'test-user-123',
        'photo2.png',
        'images',
        context.user,
      );

      const msg0Content = result.messages[0].content as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      const msg2Content = result.messages[2].content as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      expect(
        msg0Content.find((b) => b.type === 'image_url')?.image_url?.url,
      ).toBe('data:image/png;base64,INFLATED');
      expect(
        msg2Content.find((b) => b.type === 'image_url')?.image_url?.url,
      ).toBe('data:image/png;base64,INFLATED');
    });

    it('skips already-inflated data: URLs (idempotent)', async () => {
      mockGetBlob.mockResolvedValue('data:image/png;base64,SHOULD_NOT_FIRE');

      const context = createTestChatContext({
        messages: [
          userImage('data:image/png;base64,ORIGINAL'),
          { role: 'user', content: 'follow-up' } as Message,
        ],
      });

      const result = await stage.execute(context);

      expect(mockGetBlob).not.toHaveBeenCalled();
      const content = result.messages[0].content as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      expect(content.find((b) => b.type === 'image_url')?.image_url?.url).toBe(
        'data:image/png;base64,ORIGINAL',
      );
    });

    it('passes failed images through unchanged so others still inflate', async () => {
      mockGetBlob
        .mockRejectedValueOnce(new Error('blob 404'))
        .mockResolvedValueOnce('data:image/png;base64,GOOD');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const context = createTestChatContext({
        messages: [
          userImage('/api/file/missing.png'),
          assistantText('hmm'),
          userImage('/api/file/present.png'),
        ],
      });

      const result = await stage.execute(context);

      const msg0Content = result.messages[0].content as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      const msg2Content = result.messages[2].content as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      expect(
        msg0Content.find((b) => b.type === 'image_url')?.image_url?.url,
      ).toBe('/api/file/missing.png');
      expect(
        msg2Content.find((b) => b.type === 'image_url')?.image_url?.url,
      ).toBe('data:image/png;base64,GOOD');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to inflate'),
      );

      warnSpy.mockRestore();
    });

    it('leaves non-image content (text, file_url, string) untouched', async () => {
      mockGetBlob.mockResolvedValue('data:image/png;base64,X');

      const context = createTestChatContext({
        messages: [
          { role: 'user', content: 'plain string content' } as Message,
          {
            role: 'user',
            content: [
              { type: 'text', text: 'with file' },
              {
                type: 'file_url',
                url: '/api/file/doc.pdf',
                originalFilename: 'doc.pdf',
              },
              {
                type: 'image_url',
                image_url: { url: '/api/file/i.png', detail: 'auto' },
              },
            ],
          } as Message,
        ],
      });

      const result = await stage.execute(context);

      // String content is unchanged
      expect(result.messages[0].content).toBe('plain string content');

      // File and text blocks survive; only the image_url URL changes
      const blocks = result.messages[1].content as Array<{
        type: string;
        text?: string;
        url?: string;
        image_url?: { url: string };
      }>;
      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toEqual({ type: 'text', text: 'with file' });
      expect(blocks[1].url).toBe('/api/file/doc.pdf');
      expect(blocks[2].image_url?.url).toBe('data:image/png;base64,X');
    });

    it('does not mutate the input messages array', async () => {
      mockGetBlob.mockResolvedValue('data:image/png;base64,X');
      const originalMessages: Message[] = [
        userImage('/api/file/a.png'),
        { role: 'user', content: 'next' } as Message,
      ];
      const snapshot = JSON.stringify(originalMessages);
      const context = createTestChatContext({ messages: originalMessages });

      await stage.execute(context);

      expect(JSON.stringify(originalMessages)).toBe(snapshot);
    });
  });
});
