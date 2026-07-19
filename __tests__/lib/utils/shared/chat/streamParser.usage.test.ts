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

describe('terminal metadata block split across chunks', () => {
  // Regression: parseMetadataFromContent only reports metadataStartIndex once
  // a block is COMPLETE. When the block straddled two network reads, the
  // half-arrived marker was flushed into displayText — and since
  // processedIndex is monotonic, it could never be retracted, so
  // "<<<METADATA_START>>>{..." rendered inside the assistant message.
  // Affects every streamed response whose metadata is large enough to split
  // (citations, fileCacheUpdates), not just local-model turns.
  const encoder = new TextEncoder();

  const build = (text: string) =>
    `${text}\n\n<<<METADATA_START>>>${JSON.stringify({
      usage: {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        modelId: 'gpt-test',
        region: null,
      },
    })}<<<METADATA_END>>>`;

  it('never leaks a partial marker into display text, at any split point', () => {
    const raw = build('Visible answer');
    const bytes = encoder.encode(raw);

    // Every possible split, including ones landing mid-marker and mid-JSON.
    for (let cut = 1; cut < bytes.length; cut++) {
      const parser = new StreamParser();
      parser.processChunk(bytes.slice(0, cut), { stream: true });
      parser.processChunk(bytes.slice(cut), { stream: true });

      expect(parser.finalize()).toBe('Visible answer');
      expect(parser.getUsage()?.totalTokens).toBe(3);
    }
  });

  it('holds back a trailing partial marker until the rest arrives', () => {
    const parser = new StreamParser();
    parser.processChunk(encoder.encode('Answer\n\n<<<METADATA_ST'), {
      stream: true,
    });
    // Mid-stream the partial marker must already be hidden from the user.
    expect(parser.finalize()).toBe('Answer');
  });
});
