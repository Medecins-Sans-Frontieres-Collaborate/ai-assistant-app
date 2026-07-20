/**
 * Abort identity on the browser-direct local path.
 *
 * chatStore.handleSendError recognises a user-initiated stop ONLY by
 * `error.name === 'AbortError'`. If a stop surfaced under any other name it
 * would fall through to the auto-retry branch and resend the conversation to
 * a CLOUD fallback model — exactly what someone running a local model is
 * trying to avoid. These tests pin that contract.
 */
import {
  LocalRuntimeError,
  localChatService,
} from '@/client/services/chat/LocalChatService';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { afterEach, describe, expect, it, vi } from 'vitest';

const MODEL: OpenAIModel = {
  id: 'local-ollama-mistral',
  name: 'mistral',
  deploymentName: 'mistral',
  maxLength: 32000,
  tokenLimit: 4096,
  isLocalModel: true,
  localRuntime: 'ollama',
};

const MESSAGES: Message[] = [
  { role: 'user', content: 'hello', messageType: undefined },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('abort identity', () => {
  it('preserves AbortError when fetch rejects with one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')),
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      localChatService.chat(MODEL, MESSAGES, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('re-asserts AbortError when the signal fired but fetch reported otherwise', async () => {
    // Some environments surface an aborted fetch as a plain TypeError. The
    // signal is the source of truth.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      localChatService.chat(MODEL, MESSAGES, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does NOT disguise a genuine connection failure as an abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );

    // No abort — a real "runtime is down". Must be actionable, and must not
    // be mistaken for a user stop.
    const error = await localChatService
      .chat(MODEL, MESSAGES, { signal: new AbortController().signal })
      .catch((e) => e);

    expect(error).toBeInstanceOf(LocalRuntimeError);
    expect(error.name).not.toBe('AbortError');
    expect(error.reason).toBe('not_running');
  });
});

describe('non-2xx classification', () => {
  it('maps 404 to model_missing so the user is told to re-detect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, body: null }),
    );

    const error = await localChatService.chat(MODEL, MESSAGES).catch((e) => e);
    expect(error).toBeInstanceOf(LocalRuntimeError);
    expect(error.reason).toBe('model_missing');
  });

  it('maps other non-2xx to http_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, body: null }),
    );

    const error = await localChatService.chat(MODEL, MESSAGES).catch((e) => e);
    expect(error.reason).toBe('http_error');
  });
});

describe('request shape', () => {
  it('targets loopback by IP and asks for usage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, body: null });
    vi.stubGlobal('fetch', fetchMock);

    await localChatService
      .chat(MODEL, MESSAGES, { port: 4321 })
      .catch(() => {});

    const [url, init] = fetchMock.mock.calls[0];
    // 127.0.0.1, never "localhost": localhost can resolve to ::1 first while
    // Ollama binds IPv4.
    expect(url).toBe('http://127.0.0.1:4321/v1/chat/completions');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('mistral');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('prepends the system prompt and drops empty turns', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, body: null });
    vi.stubGlobal('fetch', fetchMock);

    await localChatService
      .chat(
        MODEL,
        [
          { role: 'user', content: 'first', messageType: undefined },
          { role: 'assistant', content: '', messageType: undefined },
          { role: 'user', content: 'second', messageType: undefined },
        ],
        { prompt: 'be brief' },
      )
      .catch(() => {});

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('rejects a model with no runtime association', async () => {
    const error = await localChatService
      .chat({ ...MODEL, localRuntime: undefined }, MESSAGES)
      .catch((e) => e);
    expect(error).toBeInstanceOf(LocalRuntimeError);
  });
});
