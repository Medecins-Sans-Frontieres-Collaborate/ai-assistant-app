/**
 * Browser-direct chat against a local model runtime.
 *
 * Unlike ChatService, this never touches /api/chat. The app is deployed, so a
 * server-side fetch to loopback would reach the container rather than the
 * user's machine — the request has to originate in the page.
 *
 * The consequence is that everything the server pipeline provides is absent
 * here: no RAG, no MCP tool loop, no image inflation, no cross-region routing,
 * no cloud fallback. Those are deliberately out of scope rather than silently
 * degraded; see the guards in chatStore.
 *
 * The returned stream is in the app's own wire format (bare text + optional
 * terminal metadata block), so chatStore.processStream and StreamParser
 * consume it with no special-casing.
 */
import { MessageContentAnalyzer } from '@/lib/utils/shared/chat/messageContentAnalyzer';
import { normalizeMessagesForAPI } from '@/lib/utils/shared/chat/messageNormalization';
import { createOpenAiSseToAppStream } from '@/lib/utils/shared/chat/openaiSseToAppStream';

import { Message } from '@/types/chat';
import {
  LocalRuntimeErrorReason,
  buildLocalBaseUrl,
} from '@/types/localRuntime';
import { OpenAIModel } from '@/types/openai';

/**
 * A failure with a cause specific enough to act on. Without this, all four
 * distinct causes collapse into "Failed to send message" in the UI.
 *
 * NOTE the `name` is set to 'LocalRuntimeError', never 'AbortError' — see the
 * abort handling in `chat()` for why that distinction is load-bearing.
 */
export class LocalRuntimeError extends Error {
  readonly reason: LocalRuntimeErrorReason;

  constructor(reason: LocalRuntimeErrorReason, message?: string) {
    super(message ?? reason);
    this.name = 'LocalRuntimeError';
    this.reason = reason;
  }
}

export interface LocalChatOptions {
  /** User-configured port override for this runtime, if any. */
  port?: number;
  /** System prompt to prepend. */
  prompt?: string;
  temperature?: number;
  signal?: AbortSignal;
}

interface OpenAiWireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Flattens app messages to plain-text OpenAI wire messages.
 *
 * v1 is text-only: file and image parts are dropped, because inflating a
 * `/api/file/{id}` reference into base64 is a server-side stage that this
 * path doesn't have. Local models are advertised with `supportsVision: false`
 * and file context disabled, so the UI should prevent attachments from
 * reaching here at all — this is the backstop.
 */
function toWireMessages(
  messages: Message[],
  systemPrompt?: string,
): OpenAiWireMessage[] {
  const wire: OpenAiWireMessage[] = [];

  if (systemPrompt && systemPrompt.trim() !== '') {
    wire.push({ role: 'system', content: systemPrompt });
  }

  for (const message of messages) {
    // 'system' is legal on the wire; anything else unexpected maps to 'user'
    // rather than being dropped, so no turn silently vanishes.
    const role: OpenAiWireMessage['role'] =
      message.role === 'assistant'
        ? 'assistant'
        : message.role === 'system'
          ? 'system'
          : 'user';

    const content = new MessageContentAnalyzer(message).extractText();
    if (content.trim() === '') continue;

    wire.push({ role, content });
  }

  return wire;
}

/**
 * Rethrows as an AbortError when the caller aborted.
 *
 * This is load-bearing and subtle. chatStore.handleSendError keys on
 * `error.name === 'AbortError'` to recognise a user-initiated stop. If a stop
 * surfaced as any other error, it would fall through to the auto-retry branch
 * and SILENTLY RESEND THE CONVERSATION TO A CLOUD MODEL — precisely what a
 * local-model user is trying to avoid. So: never wrap, and re-assert the
 * abort whenever the signal fired.
 */
function rethrowPreservingAbort(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted || (error as Error | undefined)?.name === 'AbortError') {
    // A plain Error with the right name, NOT a DOMException: chatStore's
    // guard is `error instanceof Error && error.name === 'AbortError'`, and
    // DOMException is outside the Error prototype chain in some environments
    // (older engines, jsdom). This shape satisfies both checks everywhere.
    const aborted = new Error('Aborted');
    aborted.name = 'AbortError';
    throw aborted;
  }
  throw error;
}

class LocalChatService {
  /**
   * Streams a completion from the local runtime.
   *
   * @returns a stream in the app's wire format, ready for processStream.
   */
  public async chat(
    model: OpenAIModel,
    messages: Message[],
    options: LocalChatOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const runtime = model.localRuntime;
    if (!runtime) {
      throw new LocalRuntimeError(
        'not_running',
        'Model is not associated with a local runtime',
      );
    }

    const baseUrl = buildLocalBaseUrl(runtime, options.port);

    // Repairs legacy localStorage message shapes (null content, bare content
    // objects). Skipping this breaks older conversations on the local path.
    const { messages: normalized } = normalizeMessagesForAPI(messages);

    const body = {
      model: model.deploymentName ?? model.name,
      messages: toWireMessages(normalized, options.prompt),
      stream: true,
      // Required for the runtime to emit a final usage frame, which becomes
      // the terminal metadata block and drives per-message token display.
      stream_options: { include_usage: true },
      ...(typeof options.temperature === 'number'
        ? { temperature: options.temperature }
        : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      // Aborts must keep their identity (see rethrowPreservingAbort); anything
      // else here is a connection-level failure, which fetch reports as an
      // opaque TypeError. Name it so the UI can coach instead of showing
      // "Failed to fetch".
      if (options.signal?.aborted || (error as Error)?.name === 'AbortError') {
        rethrowPreservingAbort(error, options.signal);
      }
      throw new LocalRuntimeError('not_running', `Could not reach ${baseUrl}`);
    }

    if (!response.ok) {
      // A 404 here means the runtime is up but no longer has this model
      // loaded — a routine situation worth naming precisely, since the fix
      // (re-detect, or pull the model) is different from every other failure.
      throw new LocalRuntimeError(
        response.status === 404 ? 'model_missing' : 'http_error',
        `Local runtime returned ${response.status}`,
      );
    }

    if (!response.body) {
      throw new LocalRuntimeError('http_error', 'Local runtime sent no body');
    }

    // pipeThrough, not a manual reader loop: it lets fetch's own abort error
    // propagate untouched, which is what keeps `name === 'AbortError'` intact.
    return response.body.pipeThrough(
      createOpenAiSseToAppStream({ modelId: model.id }),
    );
  }
}

export const localChatService = new LocalChatService();
