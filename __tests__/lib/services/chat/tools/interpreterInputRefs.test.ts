import {
  MAX_INTERPRETER_INPUT_FILES,
  selectInterpreterInputRefs,
} from '@/lib/services/chat/tools/interpreterInputRefs';

import { ActiveFile, Message } from '@/types/chat';

import { describe, expect, it } from 'vitest';

const upload = (id: string, filename: string): Message =>
  ({
    role: 'user',
    content: [
      { type: 'text', text: `here is ${filename}` },
      { type: 'file_url', url: `/api/file/${id}`, originalFilename: filename },
    ],
  }) as unknown as Message;

const text = (role: 'user' | 'assistant', content: string): Message =>
  ({ role, content }) as Message;

const active = (
  id: string,
  filename: string,
  over: Partial<ActiveFile> = {},
): ActiveFile => ({
  id: `af-${id}`,
  url: `/api/file/${id}`,
  originalFilename: filename,
  addedAt: '2026-11-07T10:00:00.000Z',
  sourceMessageId: 'm1',
  status: 'ready',
  ...over,
});

const assistantGenerated = (id: string, filename: string): Message =>
  ({
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
        generated_files: [
          {
            url: `/api/file/${id}`,
            filename,
            mime_type: 'application/octet-stream',
            is_image: false,
          },
        ],
      },
    ],
  }) as unknown as Message;

const names = (refs: { filename: string }[]) => refs.map((r) => r.filename);

describe('selectInterpreterInputRefs', () => {
  it('mounts an earlier-turn upload alongside the newest one (IB26 + WB27)', () => {
    // Reproduced 2026-11-07: with only WB27 mounted, the model hand-copied
    // IB26's FTE values from text and summed them wrong.
    const refs = selectInterpreterInputRefs({
      messages: [
        upload('ib26.xlsx', 'IB26.xlsx'),
        text('assistant', 'I can read it.'),
        upload('wb27.xlsx', 'WB27.xlsx'),
      ],
      activeFiles: [
        active('ib26.xlsx', 'IB26.xlsx'),
        active('wb27.xlsx', 'WB27.xlsx'),
      ],
    });
    expect(names(refs)).toEqual(['WB27.xlsx', 'IB26.xlsx']);
    expect(refs.every((r) => r.location === 'files')).toBe(true);
  });

  it('keeps the old behaviour when there are no active files', () => {
    const refs = selectInterpreterInputRefs({
      messages: [
        upload('ib26.xlsx', 'IB26.xlsx'),
        upload('wb27.xlsx', 'WB27.xlsx'),
      ],
    });
    expect(names(refs)).toEqual(['WB27.xlsx']);
  });

  it('mounts an activated generated document next to the user attachments (#152)', () => {
    const refs = selectInterpreterInputRefs({
      messages: [
        upload('wb27.xlsx', 'WB27.xlsx'),
        assistantGenerated('memo.docx', 'Memo.docx'),
        text('user', 'Tighten the exec summary in the memo'),
      ],
      activeFiles: [
        active('wb27.xlsx', 'WB27.xlsx'),
        active('memo.docx', 'Memo.docx', { id: 'generated-memo.docx' }),
      ],
    });
    expect(names(refs)).toEqual(['WB27.xlsx', 'Memo.docx']);
  });

  it('does not fall back to unactivated generated history when the user attached files', () => {
    const refs = selectInterpreterInputRefs({
      messages: [
        assistantGenerated('old.vbs', 'old.vbs'),
        upload('data.csv', 'data.csv'),
      ],
    });
    expect(names(refs)).toEqual(['data.csv']);
  });

  it('still remounts generated history when nothing is attached', () => {
    const refs = selectInterpreterInputRefs({
      messages: [
        text('user', 'write a script'),
        assistantGenerated('s.vbs', 'script.vbs'),
        text('user', 'fix line 4'),
      ],
    });
    expect(names(refs)).toEqual(['script.vbs']);
  });

  it('skips active files the injector dropped, errored files, transcripts and data urls', () => {
    const refs = selectInterpreterInputRefs({
      messages: [text('user', 'compare everything')],
      activeFiles: [
        active('kept.xlsx', 'kept.xlsx'),
        active('over.xlsx', 'over-budget.xlsx'),
        active('bad.xlsx', 'bad.xlsx', { status: 'error' }),
        active('t', 'call.transcript.txt', {
          url: 'transcript://sync/call',
        }),
        active('d', 'inline.png', { url: 'data:image/png;base64,AAAA' }),
      ],
      droppedActiveFileIds: ['af-over.xlsx'],
    });
    expect(names(refs)).toEqual(['kept.xlsx']);
  });

  it('orders active files pinned first, then most recently used', () => {
    const refs = selectInterpreterInputRefs({
      messages: [text('user', 'go')],
      activeFiles: [
        active('old.xlsx', 'old.xlsx', {
          lastUsedAt: '2026-11-01T00:00:00.000Z',
        }),
        active('new.xlsx', 'new.xlsx', {
          lastUsedAt: '2026-11-07T00:00:00.000Z',
        }),
        active('pin.xlsx', 'pinned.xlsx', {
          pinned: true,
          lastUsedAt: '2026-10-01T00:00:00.000Z',
        }),
      ],
    });
    expect(names(refs)).toEqual(['pinned.xlsx', 'new.xlsx', 'old.xlsx']);
  });

  it('mounts active images from the images folder', () => {
    const refs = selectInterpreterInputRefs({
      messages: [text('user', 'chart it')],
      activeFiles: [
        active('photo.png', 'photo.png', { mimeType: 'image/png' }),
        active('scan.jpg', 'scan.jpg', {
          processedContent: {
            type: 'image',
            content: '',
            tokenEstimate: 0,
            processedAt: '2026-11-07T00:00:00.000Z',
          },
        }),
      ],
    });
    expect(refs.map((r) => r.location)).toEqual(['images', 'images']);
  });

  it('mounts a file reached through several sources once', () => {
    const refs = selectInterpreterInputRefs({
      messages: [upload('wb27.xlsx', 'WB27.xlsx')],
      activeFiles: [active('wb27.xlsx', 'WB27.xlsx')],
    });
    expect(names(refs)).toEqual(['WB27.xlsx']);
  });

  // Boundary bracket: exactly the cap fits, one more is cut — attachments
  // first, so the newest upload is never the one displaced.
  it('caps at the limit with attachments taking priority', () => {
    const activeFiles = Array.from(
      { length: MAX_INTERPRETER_INPUT_FILES },
      (_, i) => active(`a${i}.xlsx`, `a${i}.xlsx`),
    );
    const atCap = selectInterpreterInputRefs({
      messages: [text('user', 'go')],
      activeFiles,
    });
    expect(atCap).toHaveLength(MAX_INTERPRETER_INPUT_FILES);

    const overCap = selectInterpreterInputRefs({
      messages: [upload('new.xlsx', 'new.xlsx')],
      activeFiles,
    });
    expect(overCap).toHaveLength(MAX_INTERPRETER_INPUT_FILES);
    expect(overCap[0].filename).toBe('new.xlsx');
    expect(names(overCap)).not.toContain(
      `a${MAX_INTERPRETER_INPUT_FILES - 1}.xlsx`,
    );
  });

  it('ignores urls that are not blob-backed', () => {
    const refs = selectInterpreterInputRefs({
      messages: [text('user', 'go')],
      activeFiles: [
        active('x', 'evil.xlsx', { url: '/api/file/../../etc/passwd x' }),
      ],
    });
    expect(refs).toEqual([]);
  });
});
