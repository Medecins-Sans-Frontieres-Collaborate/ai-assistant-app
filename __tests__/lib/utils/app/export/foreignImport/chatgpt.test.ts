import {
  isChatGptExport,
  parseChatGptConversation,
  parseChatGptExport,
} from '@/lib/utils/app/export/foreignImport/chatgpt';

import { describe, expect, it } from 'vitest';

const node = (
  id: string,
  parent: string | null,
  children: string[],
  message: Record<string, unknown> | null,
) => ({ id, parent, children, message });

const msg = (
  role: string,
  parts: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  id: `m-${Math.random()}`,
  author: { role },
  create_time: 1_700_000_000,
  content: { content_type: 'text', parts },
  recipient: 'all',
  ...extra,
});

/**
 * root ─ system ─ user1 ─┬─ asst-A (abandoned)
 *                        └─ asst-B ─ user2 ─ asst-C  (current_node)
 */
const branched = {
  id: 'conv-1',
  conversation_id: 'conv-1',
  title: 'Branching test',
  create_time: 1_700_000_000,
  update_time: 1_700_000_500,
  current_node: 'asst-C',
  mapping: {
    root: node('root', null, ['sys'], null),
    sys: node('sys', 'root', ['user1'], msg('system', [''])),
    user1: node('user1', 'sys', ['asst-A', 'asst-B'], msg('user', ['Hello'])),
    'asst-A': node('asst-A', 'user1', [], msg('assistant', ['Old answer'])),
    'asst-B': node(
      'asst-B',
      'user1',
      ['user2'],
      msg('assistant', ['New answer']),
    ),
    user2: node('user2', 'asst-B', ['asst-C'], msg('user', ['Thanks'])),
    'asst-C': node(
      'asst-C',
      'user2',
      [],
      msg('assistant', ['You are welcome']),
    ),
  },
};

describe('chatgpt adapter', () => {
  it('recognises an export array and a single conversation object', () => {
    expect(isChatGptExport([branched])).toBe(true);
    expect(isChatGptExport(branched)).toBe(true);
    expect(isChatGptExport([{ uuid: 'x', chat_messages: [] }])).toBe(false);
    expect(isChatGptExport({ version: 5, history: [] })).toBe(false);
    expect(isChatGptExport([])).toBe(false);
    expect(isChatGptExport(null)).toBe(false);
  });

  it('walks only the visible branch from current_node', () => {
    const parsed = parseChatGptConversation(branched);
    expect(parsed).not.toBeNull();
    expect(parsed!.turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      'user:Hello',
      'assistant:New answer',
      'user:Thanks',
      'assistant:You are welcome',
    ]);
    expect(parsed!.title).toBe('Branching test');
    expect(parsed!.sourceId).toBe('conv-1');
    expect(parsed!.createdAt).toBe('2023-11-14T22:13:20.000Z');
    expect(parsed!.updatedAt).toBe('2023-11-14T22:21:40.000Z');
  });

  it('falls back to the newest leaf when current_node is missing', () => {
    const { current_node: _omit, ...noCurrent } = branched;
    const withTimes = {
      ...noCurrent,
      mapping: {
        ...noCurrent.mapping,
        'asst-A': node('asst-A', 'user1', [], {
          ...msg('assistant', ['Old answer']),
          create_time: 1,
        }),
        'asst-C': node('asst-C', 'user2', [], {
          ...msg('assistant', ['You are welcome']),
          create_time: 99,
        }),
      },
    };
    const parsed = parseChatGptConversation(withTimes);
    expect(parsed!.turns.at(-1)!.text).toBe('You are welcome');
  });

  it('drops tool plumbing, hidden nodes and merges consecutive assistant nodes', () => {
    const conv = {
      id: 'conv-2',
      title: 'Tools',
      current_node: 'a3',
      mapping: {
        root: node('root', null, ['u1'], null),
        u1: node('u1', 'root', ['a1'], msg('user', ['Plot this'])),
        a1: node('a1', 'u1', ['a2'], {
          ...msg('assistant', ['print(1)']),
          recipient: 'python',
          content: { content_type: 'code', text: 'print(1)' },
        }),
        a2: node('a2', 'a1', ['a3'], {
          author: { role: 'tool' },
          content: { content_type: 'execution_output', text: '1' },
        }),
        a3: node('a3', 'a2', [], {
          ...msg('assistant', ['Here is the plot.', 'And a note.']),
          content: {
            content_type: 'multimodal_text',
            parts: [
              {
                asset_pointer: 'file-service://abc',
                content_type: 'image_asset_pointer',
              },
              'Here is the plot.',
            ],
          },
        }),
      },
    };
    const parsed = parseChatGptConversation(conv)!;
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[1]).toMatchObject({
      role: 'assistant',
      text: 'Here is the plot.',
    });
    expect(parsed.droppedParts).toBe(1);
  });

  it('skips hidden messages and returns null for empty conversations', () => {
    const conv = {
      id: 'conv-3',
      title: 'Empty',
      current_node: 'u1',
      mapping: {
        root: node('root', null, ['u1'], null),
        u1: node('u1', 'root', [], {
          ...msg('user', ['secret']),
          metadata: { is_visually_hidden_from_conversation: true },
        }),
      },
    };
    expect(parseChatGptConversation(conv)).toBeNull();
  });

  it('survives a cyclic mapping without hanging', () => {
    const conv = {
      id: 'conv-4',
      title: 'Cycle',
      current_node: 'b',
      mapping: {
        a: node('a', 'b', ['b'], msg('user', ['A'])),
        b: node('b', 'a', ['a'], msg('assistant', ['B'])),
      },
    };
    const parsed = parseChatGptConversation(conv)!;
    expect(parsed.turns.map((t) => t.text)).toEqual(['A', 'B']);
  });

  it('counts malformed entries as skipped instead of throwing', () => {
    const result = parseChatGptExport([branched, { title: 'no mapping' }, 42]);
    expect(result.conversations).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });
});
