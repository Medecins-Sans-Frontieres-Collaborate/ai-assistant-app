/**
 * Issue #126: files the code interpreter generates are auto-activated so the
 * next turn can read them; images and oversized files are not.
 */
import { Conversation, MessageType } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

function makeConversation(): Conversation {
  return {
    id: 'conv-gen',
    name: 'Scripts',
    messages: [],
    model: OpenAIModels[OpenAIModelID.GPT_5_2],
    prompt: '',
    temperature: 0.7,
    folderId: null,
  };
}

function streamWith(record: unknown, text = 'Here is script.vbs.') {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.enqueue(
        new TextEncoder().encode(
          `\n\n<<<TOOL_CALL_RECORD>>>${JSON.stringify(record)}<<<END_TOOL_CALL_RECORD>>>\n\n`,
        ),
      );
      controller.close();
    },
  });
}

const record = (files: unknown[]) => ({
  id: 'ci-1',
  name: 'code_interpreter',
  server_label: null,
  arguments: null,
  status: 'completed',
  output: null,
  error: null,
  generated_files: files,
});

describe('chatStore generated-file activation', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentMessage: undefined,
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      citations: [],
      error: null,
      stopRequested: false,
      loadingMessage: null,
      regeneratingIndex: null,
    });
    useConversationStore.setState({
      conversations: [makeConversation()],
      selectedConversationId: 'conv-gen',
      folders: [],
      isLoaded: true,
    });
    global.fetch = vi.fn();
  });

  it('activates text-like generated files, skips images and oversized files', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      body: streamWith(
        record([
          {
            url: '/api/file/abc.vbs',
            filename: 'script.vbs',
            mime_type: 'application/octet-stream',
            is_image: false,
            size_bytes: 2150,
          },
          {
            url: '/api/file/def.png',
            filename: 'chart.png',
            mime_type: 'image/png',
            is_image: true,
          },
          {
            url: '/api/file/ghi.csv',
            filename: 'huge.csv',
            mime_type: 'text/csv',
            is_image: false,
            size_bytes: 5_000_000,
          },
          {
            url: '/api/file/jkl.bin',
            filename: 'model.bin',
            mime_type: 'application/octet-stream',
            is_image: false,
          },
        ]),
      ),
    } as any);

    await useChatStore.getState().sendMessage(
      {
        role: 'user',
        content: 'write me a script',
        messageType: MessageType.TEXT,
      },
      makeConversation(),
    );

    const conv = useConversationStore
      .getState()
      .conversations.find((c) => c.id === 'conv-gen')!;
    expect(conv.activeFiles?.map((f) => f.originalFilename)).toEqual([
      'script.vbs',
    ]);
    const active = conv.activeFiles![0];
    expect(active).toMatchObject({
      id: 'generated-abc.vbs',
      url: '/api/file/abc.vbs',
      status: 'idle',
      mimeType: 'application/octet-stream',
      sizeBytes: 2150,
    });
    // The record itself is still on the assistant message for the panel.
    const last = conv.messages[conv.messages.length - 1] as any;
    const assistant = last.versions
      ? last.versions[last.activeVersionIndex ?? 0]
      : last;
    expect(JSON.stringify(assistant)).toContain('script.vbs');
  });

  it('leaves active files untouched when no file was generated', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      body: streamWith(record([])),
    } as any);
    await useChatStore
      .getState()
      .sendMessage(
        { role: 'user', content: 'hi', messageType: MessageType.TEXT },
        makeConversation(),
      );
    const conv = useConversationStore
      .getState()
      .conversations.find((c) => c.id === 'conv-gen')!;
    expect(conv.activeFiles ?? []).toEqual([]);
  });
});
