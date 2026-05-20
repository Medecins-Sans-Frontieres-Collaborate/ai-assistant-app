import {
  activityKeyForEvent,
  outputItemToMarker,
} from '@/lib/services/chat/foundryEventMappers';

import { describe, expect, it } from 'vitest';

describe('activityKeyForEvent', () => {
  it.each([
    ['response.web_search_call.in_progress', 'chat.activity.searchingWeb'],
    ['response.web_search_call.searching', 'chat.activity.searchingWeb'],
    ['response.file_search_call.in_progress', 'chat.activity.searchingFiles'],
    ['response.code_interpreter_call.in_progress', 'chat.activity.runningCode'],
    [
      'response.image_generation_call.in_progress',
      'chat.activity.generatingImage',
    ],
    ['response.mcp_list_tools.in_progress', 'chat.activity.listingTools'],
    ['response.mcp_call.in_progress', 'chat.activity.callingTool'],
  ])('maps %s to %s', (eventType, expected) => {
    expect(activityKeyForEvent(eventType)).toBe(expected);
  });

  it('returns null for unknown event types', () => {
    expect(activityKeyForEvent('response.completed')).toBeNull();
    expect(activityKeyForEvent('response.output_text.delta')).toBeNull();
    expect(activityKeyForEvent('something.unknown')).toBeNull();
    expect(activityKeyForEvent(undefined)).toBeNull();
  });
});

describe('outputItemToMarker', () => {
  it('returns null when item is missing required fields', () => {
    expect(outputItemToMarker({})).toBeNull();
    expect(outputItemToMarker({ type: 'oauth_consent_request' })).toBeNull();
  });

  describe('oauth_consent_request', () => {
    it('produces an OAuth consent marker with consent_link', () => {
      const marker = outputItemToMarker({
        id: 'oauthreq_123',
        type: 'oauth_consent_request',
        consent_link: 'https://logic-apis.consent.azure-apim.net/login?x=y',
        server_label: 'NetSuite',
      });
      expect(marker).not.toBeNull();
      expect(marker).toContain('<<<CONSENT_REQUEST>>>');
      expect(marker).toContain('"kind":"oauth"');
      expect(marker).toContain(
        '"consent_url":"https://logic-apis.consent.azure-apim.net/login?x=y"',
      );
      expect(marker).toContain('"server_label":"NetSuite"');
    });

    it('returns null when consent_link is missing', () => {
      expect(
        outputItemToMarker({
          id: 'oauthreq_1',
          type: 'oauth_consent_request',
          server_label: 'NetSuite',
        }),
      ).toBeNull();
    });

    it('returns null when consent_link is an empty string', () => {
      expect(
        outputItemToMarker({
          id: 'oauthreq_1',
          type: 'oauth_consent_request',
          consent_link: '',
        }),
      ).toBeNull();
    });

    it('handles missing server_label as null', () => {
      const marker = outputItemToMarker({
        id: 'oauthreq_1',
        type: 'oauth_consent_request',
        consent_link: 'https://x',
      });
      expect(marker).toContain('"server_label":null');
    });
  });

  describe('mcp_approval_request', () => {
    it('produces an approval marker with approval_request_id, server_label, tool_name', () => {
      const marker = outputItemToMarker({
        id: 'req_abc',
        type: 'mcp_approval_request',
        name: 'create_record',
        server_label: 'NetSuite',
      });
      expect(marker).not.toBeNull();
      expect(marker).toContain('"kind":"approval"');
      expect(marker).toContain('"approval_request_id":"req_abc"');
      expect(marker).toContain('"server_label":"NetSuite"');
      expect(marker).toContain('"tool_name":"create_record"');
    });

    it('handles missing name and server_label as null', () => {
      const marker = outputItemToMarker({
        id: 'req_abc',
        type: 'mcp_approval_request',
      });
      expect(marker).toContain('"server_label":null');
      expect(marker).toContain('"tool_name":null');
    });

    it('forwards arguments verbatim when Foundry sends them as a JSON string', () => {
      const marker = outputItemToMarker({
        id: 'req_args',
        type: 'mcp_approval_request',
        name: 'list_bills',
        server_label: 'NetSuite',
        arguments: '{"query":"microsoft"}',
      });
      expect(marker).toContain(
        '"tool_arguments":"{\\"query\\":\\"microsoft\\"}"',
      );
    });

    it('serializes arguments when Foundry sends them as an object', () => {
      const marker = outputItemToMarker({
        id: 'req_args',
        type: 'mcp_approval_request',
        name: 'list_bills',
        arguments: { query: 'apple', limit: 5 },
      });
      expect(marker).not.toBeNull();
      // The marker is "\n\n<<<CONSENT_REQUEST>>>{...}<<<END_CONSENT_REQUEST>>>\n\n".
      // Pull out the JSON payload and assert that tool_arguments is a
      // JSON-encoded STRING (not an object) and that it round-trips cleanly.
      const payloadJson = marker!.match(
        /<<<CONSENT_REQUEST>>>([\s\S]*?)<<<END_CONSENT_REQUEST>>>/,
      )![1];
      const payload = JSON.parse(payloadJson);
      expect(typeof payload.tool_arguments).toBe('string');
      expect(JSON.parse(payload.tool_arguments)).toEqual({
        query: 'apple',
        limit: 5,
      });
    });

    it('emits null tool_arguments when arguments are missing', () => {
      const marker = outputItemToMarker({
        id: 'req_no_args',
        type: 'mcp_approval_request',
        name: 'no_args_tool',
      });
      expect(marker).toContain('"tool_arguments":null');
    });
  });

  describe('mcp_call', () => {
    it('emits a transient activity with callingService when server_label is set', () => {
      const marker = outputItemToMarker({
        id: 'call_1',
        type: 'mcp_call',
        name: 'fetch_data',
        server_label: 'NetSuite',
      });
      expect(marker).not.toBeNull();
      expect(marker).toContain('<<<AGENT_ACTIVITY>>>');
      expect(marker).toContain('"key":"chat.activity.callingService"');
    });

    it('falls back to callingTool when server_label is missing', () => {
      const marker = outputItemToMarker({
        id: 'call_1',
        type: 'mcp_call',
      });
      expect(marker).toContain('"key":"chat.activity.callingTool"');
    });
  });

  describe('unknown types', () => {
    it("returns null for output_item kinds we don't surface", () => {
      expect(outputItemToMarker({ id: 'msg_1', type: 'message' })).toBeNull();
      expect(outputItemToMarker({ id: 'rs_1', type: 'reasoning' })).toBeNull();
    });
  });
});

describe('dedupe semantics (caller responsibility)', () => {
  // The mapper itself doesn't track state — the handler dedupes by item.id.
  // This test documents that calling the mapper twice with the same id
  // produces two identical markers (so the handler MUST dedupe upstream).
  it('produces the same marker for repeat calls with same id', () => {
    const item = {
      id: 'oauthreq_dup',
      type: 'oauth_consent_request',
      consent_link: 'https://example.com/auth',
    };
    const a = outputItemToMarker(item);
    const b = outputItemToMarker(item);
    expect(a).toBe(b);
  });
});
