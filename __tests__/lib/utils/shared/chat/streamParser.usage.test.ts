import { TokenUsageMetadata } from '@/lib/utils/app/metadata';
import { StreamParser } from '@/lib/utils/shared/chat/streamParser';

import { describe, expect, it } from 'vitest';

const usage: TokenUsageMetadata = {
  promptTokens: 120,
  completionTokens: 480,
  totalTokens: 600,
  modelId: 'DeepSeek-V3.1',
  region: 'US',
};

function feed(parser: StreamParser, text: string) {
  parser.processChunk(new TextEncoder().encode(text));
}

describe('StreamParser.getUsage', () => {
  it('extracts usage from the terminal metadata block of a stream', () => {
    const parser = new StreamParser();
    feed(parser, 'Hello ');
    feed(parser, 'world');
    feed(
      parser,
      `\n\n<<<METADATA_START>>>${JSON.stringify({ usage })}<<<METADATA_END>>>`,
    );
    parser.finalize();
    expect(parser.getUsage()).toEqual(usage);
  });

  it('extracts usage from a non-streaming JSON body in finalize()', () => {
    const parser = new StreamParser();
    feed(parser, JSON.stringify({ text: 'answer', usage }));
    const finalText = parser.finalize();
    expect(finalText).toBe('answer');
    expect(parser.getUsage()).toEqual(usage);
  });

  it('is undefined when the server sends no usage', () => {
    const parser = new StreamParser();
    feed(parser, 'plain answer');
    parser.finalize();
    expect(parser.getUsage()).toBeUndefined();
  });
});
