import {
  GeneratedFileManifestEnricher,
  collectGeneratedFiles,
} from '@/lib/services/chat/enrichers/GeneratedFileManifestEnricher';

import { Message } from '@/types/chat';

import { createTestChatContext } from '../testUtils';

import { describe, expect, it } from 'vitest';

function generated(
  filename: string,
  extra: Partial<{ is_image: boolean; size_bytes: number; url: string }> = {},
) {
  return {
    url:
      extra.url ??
      `/api/file/${filename.replace(/\W/g, '')}hash.${filename.split('.').pop()}`,
    filename,
    mime_type: 'application/octet-stream',
    is_image: extra.is_image ?? false,
    ...(extra.size_bytes !== undefined && { size_bytes: extra.size_bytes }),
  };
}

function assistantWith(files: ReturnType<typeof generated>[]): Message {
  return {
    role: 'assistant',
    content: 'Done — see the file.',
    toolCalls: [
      {
        id: 'ci-1',
        name: 'code_interpreter',
        server_label: null,
        arguments: null,
        status: 'completed',
        output: null,
        error: null,
        generated_files: files,
      },
    ],
  } as Message;
}

describe('GeneratedFileManifestEnricher (issue #126)', () => {
  it('does not run when no assistant turn produced a file', () => {
    const enricher = new GeneratedFileManifestEnricher();
    const context = createTestChatContext({
      messages: [
        { role: 'user', content: 'write me a script' } as Message,
        { role: 'assistant', content: '```vbs\nMsgBox 1\n```' } as Message,
      ],
    });
    expect(enricher.shouldRun(context)).toBe(false);
  });

  it('appends a manifest naming every generated file, newest first, marking active ones', async () => {
    const enricher = new GeneratedFileManifestEnricher();
    const script = generated('script.vbs', { size_bytes: 2150 });
    const chart = generated('chart.png', { is_image: true });
    const later = generated('report.xlsx', { size_bytes: 40_000 });
    const context = createTestChatContext({
      systemPrompt: 'BASE PROMPT',
      messages: [
        { role: 'user', content: 'make a script' } as Message,
        assistantWith([script, chart]),
        { role: 'user', content: 'now a report' } as Message,
        assistantWith([later]),
        { role: 'user', content: 'the script errors on line 4' } as Message,
      ],
    });
    context.activeFiles = [
      {
        id: 'generated-x',
        url: script.url,
        originalFilename: 'script.vbs',
        addedAt: '2026-09-14T00:00:00.000Z',
        sourceMessageId: '',
        status: 'ready',
      },
    ];
    expect(enricher.shouldRun(context)).toBe(true);
    const result = await enricher.execute(context);
    expect(result.systemPrompt.startsWith('BASE PROMPT')).toBe(true);
    expect(result.systemPrompt).toContain(
      '## Files you generated earlier in this conversation',
    );
    const lines = result.systemPrompt
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(lines.map((l) => l.split(' ')[1])).toEqual([
      'report.xlsx',
      'chart.png',
      'script.vbs',
    ]);
    expect(lines[0]).toContain('39.1 KB');
    expect(lines[0]).toContain('from your reply #2');
    expect(lines[0]).toContain('not currently active');
    expect(lines[1]).toContain('image, shown to the user');
    expect(lines[2]).toContain(
      'active — its text is in the Active Files Context',
    );
    expect(result.systemPrompt).toContain('never claim they do not exist');
  });

  it('dedupes by url and caps the list', () => {
    const same = generated('a.csv', { url: '/api/file/samehash.csv' });
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `turn ${i}` } as Message);
      messages.push(
        assistantWith([
          same,
          generated(`file${i}.txt`, { url: `/api/file/h${i}.txt` }),
        ]),
      );
    }
    const entries = collectGeneratedFiles(messages);
    expect(entries.length).toBe(20);
    expect(entries.filter((e) => e.file.url === same.url)).toHaveLength(1);
    // Newest reply first.
    expect(entries[0].file.filename).toBe('file29.txt');
    expect(entries[0].replyOrdinal).toBe(30);
  });
});
