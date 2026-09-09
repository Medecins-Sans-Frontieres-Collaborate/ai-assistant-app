import {
  cleanShareText,
  collectShareMessages,
  renderShareMarkdown,
} from '@/lib/utils/app/share/shareContent';

import type { Conversation, Message } from '@/types/chat';

import { describe, expect, it } from 'vitest';

const LABELS = { user: 'You', assistant: 'Assistant' };

function msg(role: 'user' | 'assistant', content: string): Message {
  return { role, content } as Message;
}

function conversation(entries: unknown[]): Conversation {
  return { id: 'c1', name: 'Field report', messages: entries } as Conversation;
}

describe('cleanShareText', () => {
  it('strips thinking, stream markers, and the metadata block', () => {
    const raw =
      '<think>secret reasoning</think>Answer text.' +
      '\n\n<<<TOOL_CALL_RECORD>>>{"id":"t1"}<<<END_TOOL_CALL_RECORD>>>\n\n' +
      'More prose.' +
      '\n\n<<<METADATA_START>>>{"citations":[]}<<<METADATA_END>>>';
    const cleaned = cleanShareText(raw);
    expect(cleaned).toBe('Answer text.\n\nMore prose.');
    expect(cleaned).not.toContain('secret');
    expect(cleaned).not.toContain('<<<');
  });

  it('drops an unterminated metadata tail from an aborted stream', () => {
    expect(cleanShareText('Prose.\n\n<<<METADATA_START>>>{"cit')).toBe(
      'Prose.',
    );
  });

  it('leaves marker-lookalike content (heredocs) alone', () => {
    const code = 'Run this:\n\n```bash\ncat <<<EOF\nhello\nEOF\n```';
    expect(cleanShareText(code)).toBe(code);
  });

  it('degrades sandbox links and keeps array content text parts only', () => {
    expect(
      cleanShareText('[Download](sandbox:/mnt/data/report.xlsx) now'),
    ).toBe('Download now');
    expect(
      cleanShareText([
        { type: 'text', text: 'Question about the file' },
        { type: 'file_url', url: '/api/file/abc.pdf' },
      ] as never),
    ).toBe('Question about the file');
  });
});

describe('collectShareMessages', () => {
  const entries = [
    msg('user', 'q1'),
    msg('assistant', 'a1'),
    msg('user', 'q2'),
    msg('assistant', 'a2'),
  ];

  it('defaults to every message with content', () => {
    const collected = collectShareMessages(conversation(entries));
    expect(collected.map((m) => m.content)).toEqual(['q1', 'a1', 'q2', 'a2']);
  });

  it('assistantOnly keeps responses; lastCount slices after filtering', () => {
    expect(
      collectShareMessages(conversation(entries), {
        assistantOnly: true,
      }).map((m) => m.content),
    ).toEqual(['a1', 'a2']);
    expect(
      collectShareMessages(conversation(entries), {
        assistantOnly: true,
        lastCount: 1,
      }).map((m) => m.content),
    ).toEqual(['a2']);
    expect(
      collectShareMessages(conversation(entries), { lastCount: 3 }).map(
        (m) => m.content,
      ),
    ).toEqual(['a1', 'q2', 'a2']);
  });

  it('uses only the ACTIVE version of assistant message groups', () => {
    const grouped = conversation([
      msg('user', 'q'),
      {
        type: 'assistant_group',
        versions: [
          { content: 'draft', createdAt: 't1' },
          { content: 'final', createdAt: 't2' },
        ],
        activeIndex: 1,
      },
    ]);
    expect(collectShareMessages(grouped).map((m) => m.content)).toEqual([
      'q',
      'final',
    ]);
  });

  it('drops messages that clean to nothing', () => {
    const collected = collectShareMessages(
      conversation([
        msg('user', 'real'),
        msg('assistant', '<think>only thinking</think>'),
      ]),
    );
    expect(collected.map((m) => m.content)).toEqual(['real']);
  });
});

describe('renderShareMarkdown', () => {
  it('renders role headings for multi-message shares', () => {
    const markdown = renderShareMarkdown(
      'Field report',
      [msg('user', 'q1'), msg('assistant', 'a1')],
      LABELS,
    );
    expect(markdown).toBe(
      '# Field report\n\n## You\n\nq1\n\n## Assistant\n\na1',
    );
  });

  it('a single assistant message reads as plain prose under the title', () => {
    const markdown = renderShareMarkdown(
      'Answer',
      [msg('assistant', 'Here is the summary.')],
      LABELS,
    );
    expect(markdown).toBe('# Answer\n\nHere is the summary.');
    expect(markdown).not.toContain('## Assistant');
  });
});
