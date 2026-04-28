import {
  AGENT_ACTIVITY_CLOSE,
  AGENT_ACTIVITY_OPEN,
  CONSENT_REQUEST_CLOSE,
  CONSENT_REQUEST_OPEN,
  emitAgentActivity,
  emitConsentRequest,
  extractConsentRequests,
  extractLatestAgentActivity,
  stripIncompleteStreamMarkers,
} from '@/lib/streamMarkers';
import { describe, expect, it } from 'vitest';

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
