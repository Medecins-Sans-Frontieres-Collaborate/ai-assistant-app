import { StreamParser } from '@/lib/utils/shared/chat/streamParser';

import { describe, expect, it } from 'vitest';

/**
 * Server-reported mid-stream failures: the tool loop ends its stream CLEANLY
 * with a terminal `streamError` metadata block (aborting the socket instead
 * surfaces browser-side as an opaque NS_ERROR_NET_PARTIAL_TRANSFER-style
 * network error). The parser must expose the failure AND keep the wire
 * format out of the rendered text.
 */

function feed(parser: StreamParser, text: string) {
  parser.processChunk(new TextEncoder().encode(text));
}

const errorBlock = `\n\n<<<METADATA_START>>>${JSON.stringify({
  streamError: { code: 'TOOL_LOOP_FAILED', message: 'Tools failed.' },
})}<<<METADATA_END>>>`;

describe('StreamParser.getStreamError', () => {
  it('captures a streamError from the terminal metadata block', () => {
    const parser = new StreamParser();
    feed(parser, 'partial text');
    feed(parser, errorBlock);
    parser.finalize();

    expect(parser.getStreamError()).toEqual({
      code: 'TOOL_LOOP_FAILED',
      message: 'Tools failed.',
    });
  });

  it('is undefined on a healthy stream', () => {
    const parser = new StreamParser();
    feed(parser, 'all good');
    parser.finalize();

    expect(parser.getStreamError()).toBeUndefined();
  });

  it('keeps partial display text intact alongside the error', () => {
    const parser = new StreamParser();
    feed(parser, 'partial text');
    feed(parser, errorBlock);

    expect(parser.finalize()).toBe('partial text');
  });

  it('never leaks raw markers when the stream carried ONLY markers + the error', () => {
    // The exact shape of a tool-loop crash during LIST_TOOLS: activity
    // markers, no display text, then the error block. finalize()'s
    // raw-accumulator fallback must not return the wire format.
    const parser = new StreamParser();
    feed(
      parser,
      '\n\n<<<AGENT_ACTIVITY>>>{"key":"chat.activity.searchingWeb"}<<<END_AGENT_ACTIVITY>>>\n\n',
    );
    feed(
      parser,
      '\n\n<<<AGENT_ACTIVITY>>>{"key":"chat.activity.listingTools"}<<<END_AGENT_ACTIVITY>>>\n\n',
    );
    feed(parser, errorBlock);
    const finalText = parser.finalize();

    expect(finalText).toBe('');
    expect(parser.getStreamError()?.code).toBe('TOOL_LOOP_FAILED');
  });

  it('never leaks raw markers for a marker-only stream without metadata', () => {
    const parser = new StreamParser();
    feed(
      parser,
      '\n\n<<<AGENT_ACTIVITY>>>{"key":"chat.activity.listingTools"}<<<END_AGENT_ACTIVITY>>>\n\n',
    );

    expect(parser.finalize()).toBe('');
  });

  it('still parses non-streaming JSON bodies through the fallback', () => {
    const parser = new StreamParser();
    feed(parser, JSON.stringify({ text: 'answer' }));

    expect(parser.finalize()).toBe('answer');
  });
});
