import {
  StreamMetadata,
  TokenUsageMetadata,
  parseMetadataFromContent,
} from '@/lib/utils/app/metadata';

import { describe, expect, it } from 'vitest';

function block(meta: Partial<StreamMetadata>): string {
  return `\n\n<<<METADATA_START>>>${JSON.stringify(meta)}<<<METADATA_END>>>`;
}

const usage: TokenUsageMetadata = {
  promptTokens: 100,
  completionTokens: 200,
  totalTokens: 300,
  modelId: 'gpt-5.2',
  region: 'EU',
  reasoningEffort: 'medium',
};

describe('parseMetadataFromContent — multi-block', () => {
  it('parses a single usage block and strips it from the display text', () => {
    const { content, usage: parsed } = parseMetadataFromContent(
      `Hello world${block({ usage })}`,
    );
    expect(content).toBe('Hello world');
    expect(parsed).toEqual(usage);
  });

  it('merges TWO terminal blocks and strips BOTH (the file_cache + usage case)', () => {
    // The stream processor appends a usage block; StandardChatHandler appends
    // a second file_cache_update block after it. Both must be stripped and
    // their fields merged — before the fix the second rendered as raw JSON.
    const raw =
      'Answer text' +
      block({ usage, citations: [] }) +
      block({
        action: 'file_cache_update',
        activeFilesTokensConsumed: 42,
      });
    const parsed = parseMetadataFromContent(raw);
    expect(parsed.content).toBe('Answer text');
    expect(parsed.content).not.toContain('METADATA');
    expect(parsed.content).not.toContain('file_cache_update');
    expect(parsed.usage).toEqual(usage);
    expect(parsed.activeFilesTokensConsumed).toBe(42);
  });

  it('later blocks win per-field on conflict', () => {
    const raw = 'x' + block({ action: 'first' }) + block({ action: 'second' });
    expect(parseMetadataFromContent(raw).action).toBe('second');
  });

  it('metadataStartIndex points at the FIRST block (caps inline scan)', () => {
    const raw = 'body' + block({ usage }) + block({ action: 'file' });
    const parsed = parseMetadataFromContent(raw);
    expect(parsed.metadataStartIndex).toBe('body'.length);
  });

  it('no metadata block → clean passthrough, usage undefined', () => {
    const parsed = parseMetadataFromContent('just text');
    expect(parsed.content).toBe('just text');
    expect(parsed.usage).toBeUndefined();
    expect(parsed.metadataStartIndex).toBeNull();
  });

  it('streamError.fileUrl round-trips (expired-attachment repair path)', () => {
    const parsed = parseMetadataFromContent(
      block({
        streamError: {
          message: 'An attached file is no longer available',
          code: 'FILE_NOT_FOUND',
          fileUrl: '/api/file/abc123.pdf',
        },
      }),
    );
    expect(parsed.streamError).toEqual({
      message: 'An attached file is no longer available',
      code: 'FILE_NOT_FOUND',
      fileUrl: '/api/file/abc123.pdf',
    });
  });

  it('drops a non-string streamError.fileUrl', () => {
    const parsed = parseMetadataFromContent(
      `\n\n<<<METADATA_START>>>${JSON.stringify({
        streamError: { message: 'boom', fileUrl: 42 },
      })}<<<METADATA_END>>>`,
    );
    expect(parsed.streamError?.message).toBe('boom');
    expect(parsed.streamError?.fileUrl).toBeUndefined();
  });
});
