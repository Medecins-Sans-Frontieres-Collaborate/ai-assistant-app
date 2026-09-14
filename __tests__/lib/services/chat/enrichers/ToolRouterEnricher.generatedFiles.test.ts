/**
 * Issue #126: with nothing attached on the current turn, the interpreter
 * remounts the files it generated earlier so "fix the script you wrote"
 * runs against the real file.
 */
import { ToolRouterEnricher } from '@/lib/services/chat/enrichers/ToolRouterEnricher';

import { Message } from '@/types/chat';

import { createTestChatContext } from '../testUtils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { blobGetMock } = vi.hoisted(() => ({ blobGetMock: vi.fn() }));

vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: () => ({ get: blobGetMock }),
}));
vi.mock('@/lib/utils/app/user/session', () => ({
  getUserIdFromSession: () => 'user-1',
}));
vi.mock('@/lib/services/limits/toolBudget', () => ({
  consumeToolBudget: vi.fn().mockResolvedValue(true),
}));

function assistantWith(
  files: Array<{ url: string; filename: string; is_image?: boolean }>,
): Message {
  return {
    role: 'assistant',
    content: 'done',
    toolCalls: [
      {
        id: 'ci-1',
        name: 'code_interpreter',
        server_label: null,
        arguments: null,
        status: 'completed',
        output: null,
        error: null,
        generated_files: files.map((f) => ({
          mime_type: 'application/octet-stream',
          is_image: false,
          ...f,
        })),
      },
    ],
  } as Message;
}

describe('ToolRouterEnricher.collectInterpreterInputFiles — generated files', () => {
  let enricher: ToolRouterEnricher;

  beforeEach(() => {
    vi.clearAllMocks();
    enricher = new ToolRouterEnricher(
      { determineTool: vi.fn(), classifyDocumentTrim: vi.fn() } as any,
      { executeWebSearchTool: vi.fn() } as any,
    );
    blobGetMock.mockImplementation(async (path: string) =>
      Buffer.from(`bytes-of:${path}`),
    );
  });

  const collect = (context: ReturnType<typeof createTestChatContext>) =>
    (enricher as any).collectInterpreterInputFiles(context) as Promise<
      Array<{ filename: string; data: Buffer }>
    >;

  it('remounts generated files from the latest assistant turns when nothing is attached', async () => {
    const context = createTestChatContext({
      messages: [
        { role: 'user', content: 'write a script' } as Message,
        assistantWith([
          { url: '/api/file/h1.vbs', filename: 'script.vbs' },
          { url: '/api/file/h2.png', filename: 'chart.png', is_image: true },
        ]),
        { role: 'user', content: 'it errors on line 4, fix it' } as Message,
      ],
    });
    const files = await collect(context);
    expect(files.map((f) => f.filename)).toEqual(['script.vbs', 'chart.png']);
    expect(blobGetMock.mock.calls.map((c) => c[0])).toEqual([
      'user-1/uploads/files/h1.vbs',
      'user-1/uploads/images/h2.png',
    ]);
    expect(files[0].data.toString()).toBe(
      'bytes-of:user-1/uploads/files/h1.vbs',
    );
  });

  it("prefers the user's own attachment over generated history", async () => {
    const context = createTestChatContext({
      messages: [
        assistantWith([{ url: '/api/file/h1.vbs', filename: 'script.vbs' }]),
        {
          role: 'user',
          content: [
            { type: 'text', text: 'use this instead' },
            {
              type: 'file_url',
              url: '/api/file/u9.csv',
              originalFilename: 'data.csv',
            },
          ],
        } as unknown as Message,
      ],
    });
    const files = await collect(context);
    expect(files.map((f) => f.filename)).toEqual(['data.csv']);
  });

  it('ignores refs that are not app-relative file urls and caps at four', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      url: `/api/file/h${i}.txt`,
      filename: `f${i}.txt`,
    }));
    const context = createTestChatContext({
      messages: [
        assistantWith([
          { url: 'https://evil.example/x.txt', filename: 'x.txt' },
          ...many,
        ]),
        { role: 'user', content: 'go' } as Message,
      ],
    });
    const files = await collect(context);
    expect(files).toHaveLength(4);
    expect(blobGetMock).not.toHaveBeenCalledWith(
      expect.stringContaining('evil'),
      expect.anything(),
    );
  });
});
