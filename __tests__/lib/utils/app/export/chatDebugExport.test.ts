import { buildChatDebugBundle } from '@/lib/utils/app/export/chatDebugExport';

import { Conversation, MessageType } from '@/types/chat';

import { describe, expect, it } from 'vitest';

const SECRET_TEXT = 'my confidential quarterly numbers';
const SECRET_NAME = 'Q3 acquisition plans';
const SECRET_FILENAME = 'layoffs-draft.docx';

function makeConversation(): Conversation {
  return {
    id: 'conv-debug-12345678',
    name: SECRET_NAME,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: SECRET_TEXT },
          {
            type: 'file_url',
            url: '/api/file/abc.docx',
            originalFilename: SECRET_FILENAME,
          },
        ],
        messageType: MessageType.FILE,
      },
      {
        role: 'assistant',
        content: 'Here is a summary.',
        messageType: MessageType.TEXT,
        toolCalls: [{} as never, {} as never],
      },
    ],
    model: {
      id: 'gpt-5.2-chat',
      name: 'GPT-5.2 Chat',
      maxLength: 4000,
      tokenLimit: 4000,
    },
    prompt: 'system prompt text',
    temperature: 0.7,
    folderId: null,
    hostedRegion: 'EU',
    activeFiles: [
      {
        id: '/api/file/abc.docx-1',
        url: '/api/file/abc.docx',
        originalFilename: SECRET_FILENAME,
        addedAt: '2026-08-01T00:00:00.000Z',
        sourceMessageId: 'm1',
        status: 'error',
        errorMessage: 'File expired',
        pinned: false,
        sizeBytes: 1234,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ],
  };
}

const baseParams = {
  conversation: makeConversation(),
  streak: { message: 'boom', errorCode: 'INTERNAL_ERROR', count: 3 },
  app: { version: '2.0', build: '123', env: 'production' },
  userRegion: 'EU',
  modelListSource: 'discovery',
};

describe('buildChatDebugBundle', () => {
  it('metadata variant carries structure but never content, name, or filenames', () => {
    const json = buildChatDebugBundle({ ...baseParams, includeContent: false });
    const bundle = JSON.parse(json);

    expect(bundle.variant).toBe('metadata');
    expect(bundle.failureStreak).toEqual({
      message: 'boom',
      errorCode: 'INTERNAL_ERROR',
      count: 3,
    });
    expect(bundle.conversation.modelId).toBe('gpt-5.2-chat');
    expect(bundle.conversation.messageCount).toBe(2);
    expect(bundle.region).toEqual({ userRegion: 'EU', hostedRegion: 'EU' });
    expect(bundle.messages[0]).toMatchObject({
      role: 'user',
      contentKind: 'parts',
      partTypes: ['text', 'file_url'],
      contentLength: SECRET_TEXT.length,
    });
    expect(bundle.messages[1]).toMatchObject({
      role: 'assistant',
      contentKind: 'string',
      toolCallCount: 2,
    });
    expect(bundle.activeFiles[0]).toMatchObject({
      status: 'error',
      pinned: false,
      sizeBytes: 1234,
    });

    // The privacy contract, asserted on the raw JSON.
    expect(json).not.toContain(SECRET_TEXT);
    expect(json).not.toContain(SECRET_NAME);
    expect(json).not.toContain(SECRET_FILENAME);
    expect(json).not.toContain('system prompt text');
  });

  it('full variant adds content, name, and filenames', () => {
    const json = buildChatDebugBundle({ ...baseParams, includeContent: true });
    const bundle = JSON.parse(json);

    expect(bundle.variant).toBe('full');
    expect(json).toContain(SECRET_TEXT);
    expect(json).toContain(SECRET_NAME);
    expect(json).toContain(SECRET_FILENAME);
    // The system prompt stays out even in the full variant.
    expect(json).not.toContain('system prompt text');
  });

  it('never contains secret-bearing keys in either variant', () => {
    for (const includeContent of [false, true]) {
      const json = buildChatDebugBundle({ ...baseParams, includeContent });
      expect(json).not.toContain('mcpServers');
      expect(json).not.toContain('accessToken');
      expect(json).not.toContain('refreshToken');
      expect(json).not.toContain('apiKey');
    }
  });
});
