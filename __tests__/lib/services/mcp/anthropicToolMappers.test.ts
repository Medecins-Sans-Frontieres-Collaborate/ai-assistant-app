import {
  executedResultsToUserMessage,
  mcpToolsToAnthropicTools,
  pendingCallsToAssistantAnthropicMessage,
  reconstructAnthropicTranscript,
} from '@/lib/services/mcp/anthropicToolMappers';
import { DENIED_TOOL_RESULT } from '@/lib/services/mcp/mcpEventMappers';

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

const pending = [
  {
    id: 'toolu_A',
    serverId: 'github',
    toolName: 'list_prs',
    argumentsJson: '{"repo":"msf/app"}',
  },
  {
    id: 'toolu_B',
    serverId: 'asana',
    toolName: 'find_task',
    argumentsJson: '{}',
  },
];

describe('mcpToolsToAnthropicTools', () => {
  it('maps MCP tools to Anthropic tool declarations with prefixed names', () => {
    const tools = mcpToolsToAnthropicTools('github', [
      {
        name: 'list_prs',
        description: 'List pull requests',
        inputSchema: {
          type: 'object',
          properties: { repo: { type: 'string' } },
        },
      },
    ]);

    expect(tools).toEqual([
      {
        name: 'github__list_prs',
        description: 'List pull requests',
        input_schema: {
          type: 'object',
          properties: { repo: { type: 'string' } },
        },
      },
    ]);
  });

  it('forces input_schema.type to object when the server omits it', () => {
    const tools = mcpToolsToAnthropicTools('srv', [
      { name: 'x', inputSchema: { properties: {} } },
    ]);
    expect(tools[0].input_schema.type).toBe('object');
  });
});

describe('reconstructAnthropicTranscript', () => {
  const base: Anthropic.MessageParam[] = [
    { role: 'user', content: 'List my PRs' },
  ];

  it('REPLACES a trailing assistant text message with [text, tool_use…] blocks', () => {
    const messages: Anthropic.MessageParam[] = [
      ...base,
      { role: 'assistant', content: 'Checking…' },
    ];

    const result = reconstructAnthropicTranscript(messages, pending);

    expect(result).toHaveLength(2);
    const last = result[1];
    expect(last.role).toBe('assistant');
    const blocks = last.content as Anthropic.ContentBlockParam[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'Checking…' });
    expect(blocks[1]).toEqual({
      type: 'tool_use',
      id: 'toolu_A',
      name: 'github__list_prs',
      input: { repo: 'msf/app' }, // parsed OBJECT, not a JSON string
    });
    expect(blocks[2]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_B',
      input: {},
    });
  });

  it('omits the text block when the trailing assistant message was empty', () => {
    const messages: Anthropic.MessageParam[] = [
      ...base,
      { role: 'assistant', content: '' },
    ];

    const result = reconstructAnthropicTranscript(messages, pending);
    const blocks = result[1].content as Anthropic.ContentBlockParam[];
    expect(blocks[0].type).toBe('tool_use');
  });

  it('appends a tool_use-only assistant message when the transcript ends with a user message', () => {
    const result = reconstructAnthropicTranscript(base, pending);

    expect(result).toHaveLength(2);
    const blocks = result[1].content as Anthropic.ContentBlockParam[];
    expect(blocks.every((b) => b.type === 'tool_use')).toBe(true);
  });

  it('extracts text from block-content trailing assistant messages', () => {
    const messages: Anthropic.MessageParam[] = [
      ...base,
      { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
    ];

    const result = reconstructAnthropicTranscript(
      messages,
      pending.slice(0, 1),
    );
    const blocks = result[1].content as Anthropic.ContentBlockParam[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'On it.' });
  });

  it('degrades unparseable arguments to {} input', () => {
    const message = pendingCallsToAssistantAnthropicMessage(
      [
        {
          id: 'toolu_X',
          serverId: 's',
          toolName: 't',
          argumentsJson: '{broken',
        },
      ],
      null,
    );
    const blocks = message.content as Anthropic.ContentBlockParam[];
    expect(blocks[0]).toMatchObject({ type: 'tool_use', input: {} });
  });
});

describe('executedResultsToUserMessage', () => {
  it('produces ONE user message covering every call in order, is_error on failures only', () => {
    const message = executedResultsToUserMessage([
      { call: pending[0], text: '3 open PRs', isError: false },
      { call: pending[1], text: DENIED_TOOL_RESULT, isError: false },
      {
        call: {
          id: 'toolu_C',
          serverId: 's',
          toolName: 't',
          argumentsJson: '{}',
        },
        text: 'Tool failed: timeout',
        isError: true,
      },
    ]);

    expect(message.role).toBe('user');
    expect(message.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_A', content: '3 open PRs' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_B',
        content: 'The user declined this tool call.',
      },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_C',
        content: 'Tool failed: timeout',
        is_error: true,
      },
    ]);
  });
});

describe('transcript legality invariant', () => {
  it('reconstruct + results yields assistant tool_use immediately followed by one user message covering every pending id exactly once', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Working…' },
    ];

    const reconstructed = reconstructAnthropicTranscript(messages, pending);
    const withResults = [
      ...reconstructed,
      executedResultsToUserMessage(
        pending.map((call) => ({ call, text: 'ok', isError: false })),
      ),
    ];

    const assistantMsg = withResults[withResults.length - 2];
    const resultMsg = withResults[withResults.length - 1];
    expect(assistantMsg.role).toBe('assistant');
    expect(resultMsg.role).toBe('user');

    const toolUseIds = (assistantMsg.content as Anthropic.ContentBlockParam[])
      .filter((b) => b.type === 'tool_use')
      .map((b) => (b as Anthropic.ToolUseBlockParam).id);
    const resultIds = (
      resultMsg.content as Anthropic.ToolResultBlockParam[]
    ).map((b) => b.tool_use_id);

    expect(toolUseIds).toEqual(['toolu_A', 'toolu_B']);
    expect(resultIds).toEqual(toolUseIds);
  });
});
