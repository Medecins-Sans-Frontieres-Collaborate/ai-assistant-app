import {
  StreamInterruptedError,
  StreamParser,
} from '@/lib/utils/shared/chat/streamParser';

import { describe, expect, it } from 'vitest';

/**
 * The in-band streamError now carries the provider error `kind`
 * (lib/services/chat/providerErrors.ts) so the client can reason about the
 * cause without parsing codes. It must survive parsing and reach the error.
 */
describe('StreamParser streamError.kind', () => {
  it('extracts kind from the terminal metadata block', () => {
    const parser = new StreamParser();
    const payload = JSON.stringify({
      streamError: {
        message: 'Too many requests',
        code: 'MODEL_RATE_LIMITED',
        kind: 'rate_limit',
        retry: true,
      },
    });
    parser.processChunk(
      new TextEncoder().encode(
        `Hello\n\n<<<METADATA_START>>>${payload}<<<METADATA_END>>>`,
      ),
      { stream: false },
    );
    parser.finalize();
    expect(parser.getStreamError()).toEqual({
      message: 'Too many requests',
      code: 'MODEL_RATE_LIMITED',
      kind: 'rate_limit',
      retry: true,
    });
  });

  it('carries kind on StreamInterruptedError', () => {
    const error = new StreamInterruptedError(
      'filtered',
      'MODEL_CONTENT_FILTERED',
      false,
      undefined,
      'content_filter',
    );
    expect(error.kind).toBe('content_filter');
    expect(error.retry).toBe(false);
  });
});
