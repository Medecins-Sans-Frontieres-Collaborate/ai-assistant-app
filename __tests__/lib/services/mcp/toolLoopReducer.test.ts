import {
  parseToolArguments,
  partitionApprovals,
  reconstructTranscript,
} from '@/lib/services/mcp/toolLoopReducer';

import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

const pending = [
  {
    id: 'call_1',
    serverId: 'github',
    toolName: 'list_prs',
    argumentsJson: '{}',
  },
  {
    id: 'call_2',
    serverId: 'github',
    toolName: 'create_issue',
    argumentsJson: '{"title":"x"}',
  },
  {
    id: 'call_3',
    serverId: 'asana',
    toolName: 'find_task',
    argumentsJson: '{}',
  },
];

describe('partitionApprovals', () => {
  it('partitions approved / denied / unanswered (auto-denied)', () => {
    const plan = partitionApprovals(pending, [
      { approval_request_id: 'call_1', approve: true },
      { approval_request_id: 'call_2', approve: false },
      // call_3 unanswered
    ]);

    expect(plan.approved.map((c) => c.id)).toEqual(['call_1']);
    expect(plan.denied.map((c) => c.id)).toEqual(['call_2']);
    expect(plan.autoDenied.map((c) => c.id)).toEqual(['call_3']);
  });

  it('ignores approvals for unknown call ids (client cannot invent executions)', () => {
    const plan = partitionApprovals(pending.slice(0, 1), [
      { approval_request_id: 'call_1', approve: true },
      { approval_request_id: 'call_999', approve: true },
    ]);

    expect(plan.approved.map((c) => c.id)).toEqual(['call_1']);
    expect(plan.denied).toEqual([]);
    expect(plan.autoDenied).toEqual([]);
  });

  it('auto-denies everything when no approvals arrive', () => {
    const plan = partitionApprovals(pending, undefined);
    expect(plan.autoDenied).toHaveLength(3);
  });
});

describe('reconstructTranscript', () => {
  const base: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'List my PRs' },
  ];

  it('REPLACES a trailing assistant text message with text + tool_calls', () => {
    const messages = [
      ...base,
      { role: 'assistant' as const, content: 'Checking your PRs…' },
    ];

    const result = reconstructTranscript(messages, pending.slice(0, 1));

    expect(result).toHaveLength(3);
    const last =
      result[2] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('Checking your PRs…');
    expect(last.tool_calls).toHaveLength(1);
    expect(last.tool_calls?.[0]).toMatchObject({
      id: 'call_1',
      function: { name: 'github__list_prs', arguments: '{}' },
    });
  });

  it('appends the tool_calls message when the transcript ends with a user message', () => {
    const result = reconstructTranscript(base, pending.slice(0, 1));

    expect(result).toHaveLength(3);
    const last =
      result[2] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    expect(last.role).toBe('assistant');
    expect(last.content).toBeNull();
    expect(last.tool_calls).toHaveLength(1);
  });

  it('handles array-content assistant messages (extracts the text)', () => {
    const messages = [
      ...base,
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'On it.' }],
      },
    ];

    const result = reconstructTranscript(messages, pending.slice(0, 1));
    const last =
      result[2] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    expect(last.content).toBe('On it.');
  });
});

describe('parseToolArguments', () => {
  it('parses plain objects', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it('treats empty string as {}', () => {
    expect(parseToolArguments('')).toEqual({});
  });

  it.each([
    ['broken JSON', '{"a":'],
    ['array', '[1,2]'],
    ['scalar', '42'],
    ['null', 'null'],
    ['oversized', `{"a":"${'x'.repeat(30_000)}"}`],
  ])('returns null for %s', (_label, input) => {
    expect(parseToolArguments(input)).toBeNull();
  });
});
