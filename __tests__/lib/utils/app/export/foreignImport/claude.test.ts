import {
  isClaudeExport,
  parseClaudeConversation,
  parseClaudeExport,
} from '@/lib/utils/app/export/foreignImport/claude';

import { describe, expect, it } from 'vitest';

const conversation = {
  uuid: 'c0ffee',
  name: 'Trip planning',
  created_at: '2025-01-05T10:00:00Z',
  updated_at: '2025-01-06T10:00:00Z',
  chat_messages: [
    {
      uuid: 'm1',
      sender: 'human',
      text: 'Plan a trip',
      created_at: '2025-01-05T10:00:00Z',
      content: [{ type: 'text', text: 'Plan a trip' }],
      attachments: [{ file_name: 'notes.pdf', extracted_content: '…' }],
      files: [],
    },
    {
      uuid: 'm2',
      sender: 'assistant',
      text: 'Sure',
      created_at: '2025-01-05T10:00:05Z',
      content: [
        { type: 'text', text: 'Sure.' },
        { type: 'tool_use', name: 'artifacts', input: {} },
        { type: 'text', text: 'Here is a plan.' },
      ],
      attachments: [],
      files: [],
    },
  ],
};

describe('claude adapter', () => {
  it('recognises exports and rejects other shapes', () => {
    expect(isClaudeExport([conversation])).toBe(true);
    expect(isClaudeExport(conversation)).toBe(true);
    expect(isClaudeExport([{ title: 'x', mapping: {} }])).toBe(false);
    expect(isClaudeExport('nope')).toBe(false);
  });

  it('joins text blocks, counts dropped parts, keeps timestamps', () => {
    const parsed = parseClaudeConversation(conversation)!;
    expect(parsed.source).toBe('claude');
    expect(parsed.sourceId).toBe('c0ffee');
    expect(parsed.title).toBe('Trip planning');
    expect(parsed.turns).toEqual([
      {
        role: 'user',
        text: 'Plan a trip',
        createdAt: '2025-01-05T10:00:00.000Z',
      },
      {
        role: 'assistant',
        text: 'Sure.\n\nHere is a plan.',
        createdAt: '2025-01-05T10:00:05.000Z',
      },
    ]);
    // one attachment + one tool_use block
    expect(parsed.droppedParts).toBe(2);
    expect(parsed.updatedAt).toBe('2025-01-06T10:00:00.000Z');
  });

  it('falls back to the flat text field on older exports', () => {
    const legacy = {
      uuid: 'old',
      name: '',
      chat_messages: [
        { sender: 'human', text: 'Hi there' },
        { sender: 'assistant', text: 'Hello' },
      ],
    };
    const parsed = parseClaudeConversation(legacy)!;
    expect(parsed.turns.map((t) => t.text)).toEqual(['Hi there', 'Hello']);
    expect(parsed.title).toBe('');
  });

  it('returns null for conversations without readable turns and counts skips', () => {
    const empty = { uuid: 'e', name: 'Empty', chat_messages: [] };
    expect(parseClaudeConversation(empty)).toBeNull();
    const result = parseClaudeExport([conversation, empty, { nope: true }]);
    expect(result.conversations).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });
});
