import {
  detectForeignExport,
  isZipArchive,
} from '@/lib/utils/app/export/foreignImport/detect';

import { describe, expect, it } from 'vitest';

describe('detectForeignExport', () => {
  it('identifies ChatGPT and Claude exports and ignores our own formats', () => {
    const chatgpt = [
      {
        id: 'c1',
        title: 'T',
        current_node: 'u',
        mapping: {
          u: {
            id: 'u',
            parent: null,
            children: [],
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['hi'] },
            },
          },
        },
      },
    ];
    const claude = [
      {
        uuid: 'x',
        name: 'N',
        chat_messages: [{ sender: 'human', text: 'hi' }],
      },
    ];
    expect(detectForeignExport(chatgpt)?.source).toBe('chatgpt');
    expect(detectForeignExport(claude)?.source).toBe('claude');
    expect(
      detectForeignExport({ version: 5, history: [], folders: [] }),
    ).toBeNull();
    expect(
      detectForeignExport({
        version: 1,
        type: 'single-conversation',
        conversation: { id: 'a', name: 'b', messages: [] },
      }),
    ).toBeNull();
    expect(detectForeignExport([])).toBeNull();
  });
});

describe('isZipArchive', () => {
  it('flags by extension, mime type, and magic bytes', async () => {
    expect(
      await isZipArchive(new File(['x'], 'export.zip', { type: '' })),
    ).toBe(true);
    expect(
      await isZipArchive(
        new File(['x'], 'renamed.json', { type: 'application/zip' }),
      ),
    ).toBe(true);
    const magic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    expect(
      await isZipArchive(new File([magic], 'renamed.json', { type: '' })),
    ).toBe(true);
  });

  it('accepts plain JSON', async () => {
    expect(
      await isZipArchive(
        new File(['[{"a":1}]'], 'conversations.json', {
          type: 'application/json',
        }),
      ),
    ).toBe(false);
    expect(await isZipArchive(new File([''], 'empty.json'))).toBe(false);
  });
});
