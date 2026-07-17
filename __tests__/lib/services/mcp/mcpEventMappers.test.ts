import {
  DENIED_TOOL_RESULT,
  deniedCallToOutcomeMarker,
  pendingCallToConsentMarker,
  pendingCallsToAssistantMessage,
  toolResultToMessage,
  toolResultToRecordMarker,
  truncateToolOutput,
} from '@/lib/services/mcp/mcpEventMappers';

import { scanStreamEvents } from '@/lib/streamMarkers';
import { describe, expect, it } from 'vitest';

const call = {
  id: 'call_abc',
  serverId: 'github',
  toolName: 'list_prs',
  argumentsJson: '{"repo":"msf/app"}',
};

describe('pendingCallToConsentMarker', () => {
  it('emits a CONSENT_REQUEST the stream scanner parses back, with server_id', () => {
    const marker = pendingCallToConsentMarker(call, 'GitHub');
    const { events, displayDelta } = scanStreamEvents(marker, 0);

    // The scanner keeps the marker's framing newlines as display text.
    expect(displayDelta.trim()).toBe('');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'consent_request',
      payload: {
        kind: 'approval',
        approval_request_id: 'call_abc',
        server_id: 'github',
        server_label: 'GitHub',
        tool_name: 'list_prs',
        tool_arguments: '{"repo":"msf/app"}',
      },
    });
  });
});

describe('toolResultToRecordMarker', () => {
  it('emits a completed TOOL_CALL_RECORD with output and duration', () => {
    const marker = toolResultToRecordMarker(
      call,
      'GitHub',
      { text: '3 open PRs', isError: false },
      420,
    );
    const { events } = scanStreamEvents(marker, 0);

    expect(events[0]).toMatchObject({
      type: 'tool_call_record',
      payload: {
        id: 'call_abc',
        name: 'list_prs',
        server_label: 'GitHub',
        status: 'completed',
        output: '3 open PRs',
        error: null,
        duration_ms: 420,
      },
    });
  });

  it('marks errors as failed with no output', () => {
    const marker = toolResultToRecordMarker(
      call,
      'GitHub',
      { errorMessage: 'MCP server "GitHub" unreachable (timeout)' },
      100,
    );
    const { events } = scanStreamEvents(marker, 0);

    expect(events[0]).toMatchObject({
      type: 'tool_call_record',
      payload: {
        status: 'failed',
        output: null,
        error: 'MCP server "GitHub" unreachable (timeout)',
      },
    });
  });

  it('truncates giant outputs with an explicit note', () => {
    const truncated = truncateToolOutput('x'.repeat(40_000));
    expect(truncated.length).toBeLessThan(40_000);
    expect(truncated).toContain('truncated 10000 characters');
  });
});

describe('deniedCallToOutcomeMarker', () => {
  it('emits a CONSENT_OUTCOME with approve=false', () => {
    const { events } = scanStreamEvents(
      deniedCallToOutcomeMarker('call_abc'),
      0,
    );
    expect(events[0]).toMatchObject({
      type: 'consent_outcome',
      payload: { approval_request_id: 'call_abc', approve: false },
    });
  });
});

describe('message shapes', () => {
  it('builds a legal role:tool message', () => {
    expect(toolResultToMessage(call, DENIED_TOOL_RESULT)).toEqual({
      role: 'tool',
      tool_call_id: 'call_abc',
      content: 'The user declined this tool call.',
    });
  });

  it('builds the reconstructed assistant message with tool_calls', () => {
    const message = pendingCallsToAssistantMessage(
      [
        {
          id: 'call_abc',
          modelToolName: 'github__list_prs',
          argumentsJson: '{"repo":"msf/app"}',
        },
      ],
      'Let me check your PRs.',
    );

    expect(message).toEqual({
      role: 'assistant',
      content: 'Let me check your PRs.',
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: {
            name: 'github__list_prs',
            arguments: '{"repo":"msf/app"}',
          },
        },
      ],
    });
  });
});
