/**
 * The two-probe design is the reason this module exists: from a single failed
 * fetch, "nothing is listening" and "listening but CORS-blocked" are the same
 * opaque TypeError. The second is the likeliest real failure and the only one
 * the user can actually fix, so it must be named correctly.
 */
import { probeLocalRuntime } from '@/client/services/models/localRuntimeProbe';

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Routes by request mode so the two probes can be answered independently. */
function stubFetch(handlers: { cors: () => unknown; noCors?: () => unknown }) {
  const mock = vi.fn((_url: string, init?: RequestInit) => {
    const isNoCors = init?.mode === 'no-cors';
    const handler = isNoCors ? handlers.noCors : handlers.cors;
    if (!handler) return Promise.reject(new TypeError('Failed to fetch'));
    try {
      return Promise.resolve(handler());
    } catch (e) {
      return Promise.reject(e);
    }
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const reject = () => {
  throw new TypeError('Failed to fetch');
};

describe('probeLocalRuntime', () => {
  it('reports ready and lists model ids', async () => {
    stubFetch({
      cors: () => ({
        ok: true,
        json: async () => ({
          data: [{ id: 'llama3.1:8b' }, { id: 'mistral' }],
        }),
      }),
    });

    const status = await probeLocalRuntime('ollama');
    expect(status.state).toBe('ready');
    if (status.state !== 'ready') return;
    expect(status.models.map((m) => m.id)).toEqual(['llama3.1:8b', 'mistral']);
  });

  it('distinguishes cors_blocked from not_running', async () => {
    // Something IS listening (no-cors resolves) but the CORS request fails.
    stubFetch({ cors: reject, noCors: () => ({ type: 'opaque' }) });
    await expect(probeLocalRuntime('ollama')).resolves.toMatchObject({
      state: 'error',
      reason: 'cors_blocked',
    });

    // Nothing listening: both probes fail.
    stubFetch({ cors: reject, noCors: reject });
    await expect(probeLocalRuntime('ollama')).resolves.toMatchObject({
      state: 'error',
      reason: 'not_running',
    });
  });

  it('treats a readable non-2xx as http_error without a second probe', async () => {
    // Reading the status proves CORS was fine, so probe A is unnecessary.
    const mock = stubFetch({ cors: () => ({ ok: false, status: 500 }) });
    await expect(probeLocalRuntime('ollama')).resolves.toMatchObject({
      state: 'error',
      reason: 'http_error',
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('never throws, and tolerates a malformed model list', async () => {
    stubFetch({
      cors: () => ({
        ok: true,
        json: async () => ({ data: [{ id: 'ok' }, { id: 42 }, {}, null] }),
      }),
    });

    const status = await probeLocalRuntime('ollama');
    expect(status.state).toBe('ready');
    if (status.state !== 'ready') return;
    // Non-string ids are dropped rather than crashing the pane.
    expect(status.models.map((m) => m.id)).toEqual(['ok']);
  });

  it('uses the default port, and honours an override', async () => {
    const mock = stubFetch({ cors: () => ({ ok: false, status: 500 }) });

    await probeLocalRuntime('ollama');
    expect(mock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/models');

    await probeLocalRuntime('lmstudio');
    expect(mock.mock.calls[1][0]).toBe('http://127.0.0.1:1234/v1/models');

    await probeLocalRuntime('ollama', 9999);
    expect(mock.mock.calls[2][0]).toBe('http://127.0.0.1:9999/v1/models');
  });

  it('ignores an out-of-range port override rather than dialling it', async () => {
    const mock = stubFetch({ cors: () => ({ ok: false, status: 500 }) });
    await probeLocalRuntime('ollama', 70000);
    expect(mock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/models');
  });
});
