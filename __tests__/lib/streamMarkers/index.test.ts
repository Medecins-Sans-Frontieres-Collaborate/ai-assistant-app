import {
  AGENT_ACTIVITY_CLOSE,
  AGENT_ACTIVITY_OPEN,
  CONSENT_OUTCOME_CLOSE,
  CONSENT_OUTCOME_OPEN,
  CONSENT_REQUEST_CLOSE,
  CONSENT_REQUEST_OPEN,
  TOOL_CALL_RECORD_CLOSE,
  TOOL_CALL_RECORD_OPEN,
  emitAgentActivity,
  emitConsentOutcome,
  emitConsentRequest,
  emitToolCallRecord,
  extractConsentOutcomes,
  extractConsentRequests,
  extractLatestAgentActivity,
  extractToolCallRecords,
  scanStreamEvents,
  stripIncompleteStreamMarkers,
} from '@/lib/streamMarkers';
import { describe, expect, it } from 'vitest';

/**
 * Drives scanStreamEvents the way StreamParser.processChunk does: accumulate
 * the full text, re-scan from the monotonic processedIndex each chunk, and
 * collect display deltas + events across the whole stream.
 */
function runChunks(chunks: string[]): {
  display: string;
  events: ReturnType<typeof scanStreamEvents>['events'];
} {
  let text = '';
  let processedIndex = 0;
  let display = '';
  const events: ReturnType<typeof scanStreamEvents>['events'] = [];
  for (const c of chunks) {
    text += c;
    const scan = scanStreamEvents(text, processedIndex);
    processedIndex = scan.nextIndex;
    display += scan.displayDelta;
    events.push(...scan.events);
  }
  return { display, events };
}

/** Splits `full` into two chunks at `idx`. */
function splitAt(full: string, idx: number): [string, string] {
  return [full.slice(0, idx), full.slice(idx)];
}

describe('emitAgentActivity', () => {
  it('produces a sentinel-wrapped JSON payload', () => {
    const out = emitAgentActivity('chat.activity.searchingWeb');
    expect(out).toContain(AGENT_ACTIVITY_OPEN);
    expect(out).toContain(AGENT_ACTIVITY_CLOSE);
    expect(out).toContain('"key":"chat.activity.searchingWeb"');
  });

  it('wraps in newlines so the marker survives markdown rendering edges', () => {
    const out = emitAgentActivity('x');
    expect(out.startsWith('\n\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('embeds params when provided', () => {
    const out = emitAgentActivity('chat.activity.usingNamedTool', {
      tool: 'get_invoice',
    });
    expect(out).toContain('"params":{"tool":"get_invoice"}');
  });

  it('omits the params field when none are passed', () => {
    const out = emitAgentActivity('x');
    expect(out).not.toContain('"params"');
  });
});

describe('emitConsentRequest', () => {
  it('emits an OAuth payload with a consent_url', () => {
    const out = emitConsentRequest({
      kind: 'oauth',
      consent_url: 'https://example.com/auth',
      server_label: 'NetSuite',
    });
    expect(out).toContain(CONSENT_REQUEST_OPEN);
    expect(out).toContain(CONSENT_REQUEST_CLOSE);
    expect(out).toContain('"kind":"oauth"');
    expect(out).toContain('"consent_url":"https://example.com/auth"');
    expect(out).toContain('"server_label":"NetSuite"');
  });

  it('emits an approval payload', () => {
    const out = emitConsentRequest({
      kind: 'approval',
      approval_request_id: 'req_123',
      tool_name: 'create_record',
    });
    expect(out).toContain('"kind":"approval"');
    expect(out).toContain('"approval_request_id":"req_123"');
  });
});

describe('extractLatestAgentActivity', () => {
  it('returns null when no activity markers are present', () => {
    const result = extractLatestAgentActivity('Hello, world.');
    expect(result.latest).toBeNull();
    expect(result.cleaned).toBe('Hello, world.');
  });

  it('extracts a single activity marker', () => {
    const content = `Hi${emitAgentActivity('chat.activity.searchingWeb')}there`;
    const result = extractLatestAgentActivity(content);
    expect(result.latest).toEqual({ key: 'chat.activity.searchingWeb' });
  });

  it('returns the LATEST when multiple markers appear', () => {
    const content = [
      emitAgentActivity('chat.activity.first'),
      emitAgentActivity('chat.activity.second'),
      emitAgentActivity('chat.activity.third'),
    ].join('');
    const result = extractLatestAgentActivity(content);
    expect(result.latest).toEqual({ key: 'chat.activity.third' });
  });

  it('strips ALL activity markers (not just the matched one) from cleaned', () => {
    const content = [
      'before',
      emitAgentActivity('a'),
      'middle',
      emitAgentActivity('b'),
      'after',
    ].join('');
    const result = extractLatestAgentActivity(content);
    expect(result.cleaned).not.toContain(AGENT_ACTIVITY_OPEN);
    expect(result.cleaned).not.toContain(AGENT_ACTIVITY_CLOSE);
    expect(result.cleaned).toContain('before');
    expect(result.cleaned).toContain('middle');
    expect(result.cleaned).toContain('after');
  });

  it('drops malformed JSON silently', () => {
    const content = `${AGENT_ACTIVITY_OPEN}{not valid${AGENT_ACTIVITY_CLOSE}`;
    const result = extractLatestAgentActivity(content);
    expect(result.latest).toBeNull();
    expect(result.cleaned).not.toContain(AGENT_ACTIVITY_OPEN);
  });

  it('drops payloads missing the required key field', () => {
    const content = `${AGENT_ACTIVITY_OPEN}{"foo":"bar"}${AGENT_ACTIVITY_CLOSE}`;
    const result = extractLatestAgentActivity(content);
    expect(result.latest).toBeNull();
  });

  it('round-trips params through the latest activity', () => {
    const content = emitAgentActivity('chat.activity.usingNamedTool', {
      tool: 'get_invoice',
    });
    const result = extractLatestAgentActivity(content);
    expect(result.latest).toEqual({
      key: 'chat.activity.usingNamedTool',
      params: { tool: 'get_invoice' },
    });
  });

  it('coerces non-string param values into strings', () => {
    const content = `${AGENT_ACTIVITY_OPEN}{"key":"x","params":{"count":3,"active":true}}${AGENT_ACTIVITY_CLOSE}`;
    const result = extractLatestAgentActivity(content);
    expect(result.latest?.params).toEqual({ count: '3', active: 'true' });
  });

  it('drops invalid params (non-object) without dropping the key', () => {
    const content = `${AGENT_ACTIVITY_OPEN}{"key":"x","params":"oops"}${AGENT_ACTIVITY_CLOSE}`;
    const result = extractLatestAgentActivity(content);
    expect(result.latest).toEqual({ key: 'x' });
  });
});

describe('extractConsentRequests', () => {
  it('returns no requests when none are present', () => {
    const result = extractConsentRequests('plain text content');
    expect(result.requests).toEqual([]);
    expect(result.cleaned).toBe('plain text content');
  });

  it('extracts an OAuth request', () => {
    const content =
      'Hello' +
      emitConsentRequest({
        kind: 'oauth',
        consent_url: 'https://x',
        server_label: 'NetSuite',
      });
    const result = extractConsentRequests(content);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toEqual({
      kind: 'oauth',
      consent_url: 'https://x',
      server_label: 'NetSuite',
    });
    expect(result.cleaned).not.toContain(CONSENT_REQUEST_OPEN);
  });

  it('extracts multiple requests in order', () => {
    const content =
      emitConsentRequest({ kind: 'oauth', consent_url: 'https://a' }) +
      emitConsentRequest({
        kind: 'approval',
        approval_request_id: 'req_1',
        tool_name: 't',
      });
    const result = extractConsentRequests(content);
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0].kind).toBe('oauth');
    expect(result.requests[1].kind).toBe('approval');
  });

  it('drops malformed JSON silently', () => {
    const content = `${CONSENT_REQUEST_OPEN}not json${CONSENT_REQUEST_CLOSE}`;
    const result = extractConsentRequests(content);
    expect(result.requests).toEqual([]);
    expect(result.cleaned).not.toContain(CONSENT_REQUEST_OPEN);
  });

  it('drops unknown kinds silently', () => {
    const content = `${CONSENT_REQUEST_OPEN}{"kind":"unknown"}${CONSENT_REQUEST_CLOSE}`;
    const result = extractConsentRequests(content);
    expect(result.requests).toEqual([]);
  });
});

describe('emitConsentOutcome / extractConsentOutcomes', () => {
  it('roundtrips a single approve outcome', () => {
    const emitted = emitConsentOutcome({
      approval_request_id: 'mcpr_abc',
      approve: true,
    });
    expect(emitted).toContain(CONSENT_OUTCOME_OPEN);
    expect(emitted).toContain(CONSENT_OUTCOME_CLOSE);
    const { outcomes, cleaned } = extractConsentOutcomes(`pre${emitted}post`);
    expect(outcomes).toEqual([
      { approval_request_id: 'mcpr_abc', approve: true },
    ]);
    expect(cleaned).not.toContain(CONSENT_OUTCOME_OPEN);
    expect(cleaned).toContain('pre');
    expect(cleaned).toContain('post');
  });

  it('roundtrips a deny outcome', () => {
    const emitted = emitConsentOutcome({
      approval_request_id: 'mcpr_xyz',
      approve: false,
    });
    const { outcomes } = extractConsentOutcomes(emitted);
    expect(outcomes).toEqual([
      { approval_request_id: 'mcpr_xyz', approve: false },
    ]);
  });

  it('extracts multiple outcomes in stream order', () => {
    const content =
      emitConsentOutcome({ approval_request_id: 'a', approve: true }) +
      'mid' +
      emitConsentOutcome({ approval_request_id: 'b', approve: false });
    const { outcomes, cleaned } = extractConsentOutcomes(content);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].approval_request_id).toBe('a');
    expect(outcomes[0].approve).toBe(true);
    expect(outcomes[1].approval_request_id).toBe('b');
    expect(outcomes[1].approve).toBe(false);
    expect(cleaned).toContain('mid');
    expect(cleaned).not.toContain(CONSENT_OUTCOME_OPEN);
  });

  it('drops malformed JSON silently and still strips the marker', () => {
    const content = `${CONSENT_OUTCOME_OPEN}not json${CONSENT_OUTCOME_CLOSE}`;
    const { outcomes, cleaned } = extractConsentOutcomes(content);
    expect(outcomes).toEqual([]);
    expect(cleaned).not.toContain(CONSENT_OUTCOME_OPEN);
  });

  it('drops payloads missing required fields', () => {
    const noId = `${CONSENT_OUTCOME_OPEN}{"approve":true}${CONSENT_OUTCOME_CLOSE}`;
    const noBool = `${CONSENT_OUTCOME_OPEN}{"approval_request_id":"a"}${CONSENT_OUTCOME_CLOSE}`;
    const wrongTypes = `${CONSENT_OUTCOME_OPEN}{"approval_request_id":123,"approve":"yes"}${CONSENT_OUTCOME_CLOSE}`;
    expect(extractConsentOutcomes(noId).outcomes).toEqual([]);
    expect(extractConsentOutcomes(noBool).outcomes).toEqual([]);
    expect(extractConsentOutcomes(wrongTypes).outcomes).toEqual([]);
  });

  it('returns empty array and unchanged content when no markers present', () => {
    const { outcomes, cleaned } = extractConsentOutcomes('plain text');
    expect(outcomes).toEqual([]);
    expect(cleaned).toBe('plain text');
  });
});

describe('emitToolCallRecord / extractToolCallRecords', () => {
  const sampleRecord = {
    id: 'call_1',
    name: 'get_invoice',
    server_label: 'NetSuite',
    arguments: '{"id":"INV-1"}',
    status: 'completed' as const,
    output: '{"total":42}',
    error: null,
    duration_ms: 1234,
    approval_request_id: 'mcpr_abc',
  };

  it('roundtrips a completed record', () => {
    const emitted = emitToolCallRecord(sampleRecord);
    expect(emitted).toContain(TOOL_CALL_RECORD_OPEN);
    expect(emitted).toContain(TOOL_CALL_RECORD_CLOSE);
    const { records, cleaned } = extractToolCallRecords(`pre${emitted}post`);
    expect(records).toEqual([sampleRecord]);
    expect(cleaned).toContain('pre');
    expect(cleaned).toContain('post');
    expect(cleaned).not.toContain(TOOL_CALL_RECORD_OPEN);
  });

  it('extracts multiple records preserving order', () => {
    const content =
      emitToolCallRecord({ ...sampleRecord, id: 'a' }) +
      emitToolCallRecord({ ...sampleRecord, id: 'b', status: 'failed' });
    const { records } = extractToolCallRecords(content);
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe('a');
    expect(records[1].id).toBe('b');
    expect(records[1].status).toBe('failed');
  });

  it('drops malformed JSON silently', () => {
    const content = `${TOOL_CALL_RECORD_OPEN}not json${TOOL_CALL_RECORD_CLOSE}`;
    const { records, cleaned } = extractToolCallRecords(content);
    expect(records).toEqual([]);
    expect(cleaned).not.toContain(TOOL_CALL_RECORD_OPEN);
  });

  it('drops payloads missing required fields', () => {
    const noName = `${TOOL_CALL_RECORD_OPEN}{"id":"a","status":"completed"}${TOOL_CALL_RECORD_CLOSE}`;
    const noStatus = `${TOOL_CALL_RECORD_OPEN}{"id":"a","name":"t"}${TOOL_CALL_RECORD_CLOSE}`;
    expect(extractToolCallRecords(noName).records).toEqual([]);
    expect(extractToolCallRecords(noStatus).records).toEqual([]);
  });
});

describe('stripIncompleteStreamMarkers', () => {
  it('returns content unchanged when there are no markers', () => {
    expect(stripIncompleteStreamMarkers('hello world')).toBe('hello world');
  });

  it('returns content unchanged when complete markers are present', () => {
    const content =
      'a' +
      emitAgentActivity('x') +
      'b' +
      emitConsentRequest({ kind: 'oauth', consent_url: 'u' }) +
      'c';
    // Strip should leave full markers alone — they're well-formed.
    expect(stripIncompleteStreamMarkers(content)).toBe(content);
  });

  it('hides a partial AGENT_ACTIVITY (open without close)', () => {
    const content = `visible${AGENT_ACTIVITY_OPEN}{"key":"par`;
    expect(stripIncompleteStreamMarkers(content)).toBe('visible');
  });

  it('hides a partial CONSENT_REQUEST (open without close)', () => {
    const content = `visible${CONSENT_REQUEST_OPEN}{"kind":"oa`;
    expect(stripIncompleteStreamMarkers(content)).toBe('visible');
  });

  it('hides a partial CONSENT_OUTCOME (open without close)', () => {
    const content = `visible${CONSENT_OUTCOME_OPEN}{"approval_re`;
    expect(stripIncompleteStreamMarkers(content)).toBe('visible');
  });

  it('hides a partial TOOL_CALL_RECORD (open without close)', () => {
    const content = `visible${TOOL_CALL_RECORD_OPEN}{"id":"a","name":"`;
    expect(stripIncompleteStreamMarkers(content)).toBe('visible');
  });

  it('strips both partials when both are open', () => {
    const content =
      'a' + AGENT_ACTIVITY_OPEN + 'incomplete' + CONSENT_REQUEST_OPEN + 'also';
    // The first marker (CONSENT_REQUEST per ordering) sits inside what's
    // already going to be stripped by the first incomplete pair found,
    // but the strip is robust to ordering — final output starts at "a".
    expect(stripIncompleteStreamMarkers(content)).toBe('a');
  });

  it('does not break when an open precedes a complete pair of the other kind', () => {
    const content =
      emitConsentRequest({ kind: 'oauth', consent_url: 'u' }) +
      'mid' +
      AGENT_ACTIVITY_OPEN +
      'partial';
    const out = stripIncompleteStreamMarkers(content);
    // Complete consent marker survives, partial activity marker is hidden.
    expect(out).toContain(CONSENT_REQUEST_OPEN);
    expect(out).not.toContain(AGENT_ACTIVITY_OPEN);
    expect(out).toContain('mid');
  });
});

describe('scanStreamEvents — markers split across chunk boundaries', () => {
  const activity =
    AGENT_ACTIVITY_OPEN +
    '{"key":"chat.activity.searchingWeb"}' +
    AGENT_ACTIVITY_CLOSE;
  const full = `before${activity}after`;

  it('recovers an event when the OPEN tag is split across chunks', () => {
    // Split partway through "<<<AGENT_ACTIVITY>>>".
    const idx = 'before'.length + '<<<AGENT_ACTI'.length;
    const { display, events } = runChunks(splitAt(full, idx));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent_activity',
      payload: { key: 'chat.activity.searchingWeb' },
    });
    // No marker fragment leaks into display.
    expect(display).toBe('beforeafter');
  });

  it('recovers an event when the CLOSE tag is split across chunks', () => {
    const idx = full.indexOf(AGENT_ACTIVITY_CLOSE) + '<<<END_AGENT'.length;
    const { display, events } = runChunks(splitAt(full, idx));

    expect(events).toHaveLength(1);
    expect(display).toBe('beforeafter');
  });

  it('recovers an event when the JSON payload is split across chunks', () => {
    const idx = full.indexOf('searchingWeb');
    const { display, events } = runChunks(splitAt(full, idx));

    expect(events).toHaveLength(1);
    expect(display).toBe('beforeafter');
  });

  it('recovers an event streamed one character at a time', () => {
    const { display, events } = runChunks(full.split(''));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'agent_activity' });
    expect(display).toBe('beforeafter');
  });

  it('does not hold back literal "<<<" that is not a marker prefix', () => {
    // A chunk ending in "<<<" is held back, but once the next chunk proves it
    // is not a marker open it must be flushed (no permanent swallow).
    const { display, events } = runChunks(['a <<<', 'x b']);

    expect(events).toHaveLength(0);
    expect(display).toBe('a <<<x b');
  });
});
