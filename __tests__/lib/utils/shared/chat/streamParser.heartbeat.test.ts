import { StreamParser } from '@/lib/utils/shared/chat/streamParser';

import { HEARTBEAT_ACTIVITY_KEY, emitAgentActivity } from '@/lib/streamMarkers';
import { describe, expect, it } from 'vitest';

/**
 * The chat route's keepalive heartbeat (issue #130) is a real activity
 * marker so a long silent model wait keeps bytes flowing — but it must
 * never overwrite a more specific activity a slow stage is still on.
 */
function feed(parser: StreamParser, text: string) {
  return parser.processChunk(new TextEncoder().encode(text));
}

describe('StreamParser - heartbeat activity', () => {
  it('drives the loader when nothing more specific has been shown', () => {
    const parser = new StreamParser();
    const result = feed(parser, emitAgentActivity(HEARTBEAT_ACTIVITY_KEY));
    expect(result.action).toBe(HEARTBEAT_ACTIVITY_KEY);
    // Marker padding only — nothing a reader would see.
    expect(result.displayText.trim()).toBe('');
    expect(result.hasReceivedContent).toBe(false);
  });

  it('does not replace an activity a stage already reported', () => {
    const parser = new StreamParser();
    feed(
      parser,
      emitAgentActivity('chat.activity.searchingWebFor', { query: 'x' }),
    );
    const result = feed(parser, emitAgentActivity(HEARTBEAT_ACTIVITY_KEY));
    expect(result.action).toBe('chat.activity.searchingWebFor');
    expect(result.actionParams).toEqual({ query: 'x' });
  });

  it('is itself replaced by a later, more specific activity', () => {
    const parser = new StreamParser();
    feed(parser, emitAgentActivity(HEARTBEAT_ACTIVITY_KEY));
    const result = feed(parser, emitAgentActivity('chat.activity.runningCode'));
    expect(result.action).toBe('chat.activity.runningCode');
  });
});
