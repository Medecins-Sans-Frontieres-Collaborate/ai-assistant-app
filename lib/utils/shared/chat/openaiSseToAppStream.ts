/**
 * Translates an OpenAI-compatible SSE response into the app's chat wire
 * format, so a browser-direct local-runtime stream drops straight into the
 * existing StreamParser without any downstream changes.
 *
 * The app wire format is NOT SSE. It is:
 *   - bare UTF-8 text deltas, concatenated
 *   - optionally followed by a terminal
 *     `\n\n<<<METADATA_START>>>{json}<<<METADATA_END>>>` block
 *
 * See lib/utils/shared/chat/streamParser.ts for the consumer, and
 * lib/utils/app/metadata.ts for the marker format (reused here rather than
 * re-spelled, so the two can't drift).
 */
import {
  appendMetadataToStream,
  createStreamDecoder,
  createStreamEncoder,
} from '@/lib/utils/app/metadata';

interface OpenAiStreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAiStreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: OpenAiStreamUsage | null;
  error?: { message?: string } | string;
}

export interface OpenAiSseToAppStreamOptions {
  /**
   * The app-side model id to attribute usage to. This is the `local-*` id,
   * not the runtime's own model name, so downstream stats bucket correctly.
   */
  modelId: string;
}

/**
 * Error surfaced when the runtime reports a problem mid-stream (rather than
 * via a non-2xx, which the caller handles before streaming begins).
 */
export class LocalStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStreamError';
  }
}

/**
 * Builds the TransformStream. Stateful by necessity: SSE events split across
 * chunk boundaries mid-line and mid-JSON, so partial lines are buffered until
 * a newline arrives.
 */
export function createOpenAiSseToAppStream(
  options: OpenAiSseToAppStreamOptions,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = createStreamDecoder();
  const encoder = createStreamEncoder();

  let buffer = '';
  let usage: OpenAiStreamUsage | undefined;
  let done = false;

  /** Handles one complete `data:` payload. */
  const handlePayload = (
    payload: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    if (payload === '[DONE]') {
      done = true;
      return;
    }

    let chunk: OpenAiStreamChunk;
    try {
      chunk = JSON.parse(payload) as OpenAiStreamChunk;
    } catch {
      // A malformed frame is not worth killing an otherwise-good stream over;
      // the user would lose everything received so far. Skip it.
      return;
    }

    if (chunk.error) {
      const message =
        typeof chunk.error === 'string'
          ? chunk.error
          : (chunk.error.message ?? 'Local runtime reported an error');
      throw new LocalStreamError(message);
    }

    // Usage arrives on a final frame that carries no choices, and only when
    // the request set `stream_options: { include_usage: true }`.
    if (chunk.usage) {
      usage = chunk.usage;
    }

    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === 'string' && content.length > 0) {
      controller.enqueue(encoder.encode(content));
    }
  };

  /** Drains whole lines out of `buffer`, leaving any partial tail behind. */
  const drainLines = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      // Strip a trailing \r so CRLF framing parses identically to LF.
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);

      const trimmed = line.trim();
      // Blank lines are SSE event separators; `:` lines are comments/keepalive.
      if (trimmed !== '' && !trimmed.startsWith(':')) {
        if (trimmed.startsWith('data:')) {
          handlePayload(trimmed.slice('data:'.length).trim(), controller);
        }
        // Other SSE fields (event:, id:, retry:) are not used by any of the
        // runtimes we support; ignoring them is intentional.
      }

      newlineIndex = buffer.indexOf('\n');
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drainLines(controller);
    },

    flush(controller) {
      // Flush the decoder, then handle a final line that arrived without a
      // trailing newline.
      buffer += decoder.decode();
      if (!done && buffer.trim() !== '') {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data:')) {
          handlePayload(trimmed.slice('data:'.length).trim(), controller);
        }
      }
      buffer = '';

      if (!usage) return;

      const promptTokens = usage.prompt_tokens ?? 0;
      const completionTokens = usage.completion_tokens ?? 0;

      // appendMetadataToStream is typed for a ReadableStreamDefaultController,
      // but only ever calls .enqueue() — which TransformStreamDefaultController
      // provides identically. Casting here beats duplicating the marker
      // format, which would silently drift from parseMetadataFromContent.
      appendMetadataToStream(
        controller as unknown as ReadableStreamDefaultController,
        {
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
            modelId: options.modelId,
            // Local inference has no cloud region.
            region: null,
          },
        },
      );
    },
  });
}
