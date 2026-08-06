/**
 * uploadSessionFragments: fragment retry/resume, session cancellation on
 * abort, commit-conflict signaling, and the loud-failure contract when the
 * commit response carries no item. Graph HTTP is stubbed via global fetch;
 * retry sleeps run under fake timers.
 */
import { M365Error } from '@/lib/services/m365/graphApi';
import {
  CHUNK_SIZE,
  GraphUploadConflictError,
  uploadSessionFragments,
} from '@/lib/services/m365/graphUpload';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// graphApi transitively imports next-auth via @/auth; mock the boundary.
vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

const fetchMock = vi.fn();

const UPLOAD_URL = 'https://upload.example/session';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function statusResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, { status, headers });
}

/** Runs the upload while draining fake retry-sleep timers. */
async function run(promise: Promise<unknown>): Promise<unknown> {
  let settled = false;
  const guarded = promise.finally(() => {
    settled = true;
  });
  // Swallow here so an expected rejection isn't "unhandled" between drains.
  guarded.catch(() => undefined);
  while (!settled) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  return guarded;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('uploadSessionFragments', () => {
  it('uploads sequential Content-Range fragments and returns the item', async () => {
    const bytes = new Uint8Array(CHUNK_SIZE + 10);
    fetchMock
      .mockResolvedValueOnce(statusResponse(202))
      .mockResolvedValueOnce(jsonResponse({ id: 'item-1', name: 'a.bin' }));

    const item = await run(uploadSessionFragments(UPLOAD_URL, bytes));
    expect(item).toMatchObject({ id: 'item-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1] as RequestInit;
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect((first.headers as Record<string, string>)['Content-Range']).toBe(
      `bytes 0-${CHUNK_SIZE - 1}/${bytes.length}`,
    );
    expect((second.headers as Record<string, string>)['Content-Range']).toBe(
      `bytes ${CHUNK_SIZE}-${bytes.length - 1}/${bytes.length}`,
    );
  });

  it('retries a transient fragment failure and resumes from nextExpectedRanges', async () => {
    const bytes = new Uint8Array(1024);
    fetchMock
      .mockResolvedValueOnce(statusResponse(503)) // fragment attempt 1
      .mockResolvedValueOnce(
        jsonResponse({ nextExpectedRanges: ['0-'] }), // session status probe
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'item-1' })); // retry succeeds

    const item = await run(uploadSessionFragments(UPLOAD_URL, bytes));
    expect(item).toMatchObject({ id: 'item-1' });
    // Probe was a plain GET of the session URL.
    expect(fetchMock.mock.calls[1][0]).toBe(UPLOAD_URL);
    expect(fetchMock.mock.calls[1][1]).toBeUndefined();
  });

  it('cancels the session and throws rate_limited when 429 retries exhaust', async () => {
    const bytes = new Uint8Array(16);
    fetchMock.mockImplementation(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        if (init?.method === 'PUT') {
          return statusResponse(429, { 'retry-after': '1' });
        }
        if (init?.method === 'DELETE') return statusResponse(204);
        return jsonResponse({ nextExpectedRanges: ['0-'] });
      },
    );

    const error = (await run(
      uploadSessionFragments(UPLOAD_URL, bytes).then(
        () => null,
        (e) => e,
      ),
    )) as M365Error;
    expect(error).toBeInstanceOf(M365Error);
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(1);
    const deletes = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deletes).toHaveLength(1);
  });

  it('cancels the session immediately on a non-retryable failure', async () => {
    const bytes = new Uint8Array(16);
    fetchMock
      .mockResolvedValueOnce(statusResponse(400))
      .mockResolvedValueOnce(statusResponse(204)); // DELETE

    const error = (await run(
      uploadSessionFragments(UPLOAD_URL, bytes).then(
        () => null,
        (e) => e,
      ),
    )) as M365Error;
    expect(error).toBeInstanceOf(M365Error);
    expect(error.kind).toBe('graph_error');
    expect(
      (fetchMock.mock.calls[1][1] as RequestInit | undefined)?.method,
    ).toBe('DELETE');
  });

  it('signals a final-fragment 409 as GraphUploadConflictError', async () => {
    const bytes = new Uint8Array(16);
    fetchMock.mockResolvedValueOnce(statusResponse(409));

    const error = await run(
      uploadSessionFragments(UPLOAD_URL, bytes).then(
        () => null,
        (e) => e,
      ),
    );
    expect(error).toBeInstanceOf(GraphUploadConflictError);
  });

  it('fails loudly when the commit response has no item id', async () => {
    const bytes = new Uint8Array(16);
    fetchMock.mockResolvedValueOnce(new Response('not-json', { status: 200 }));

    const error = (await run(
      uploadSessionFragments(UPLOAD_URL, bytes).then(
        () => null,
        (e) => e,
      ),
    )) as M365Error;
    expect(error).toBeInstanceOf(M365Error);
    expect(error.message).toContain('did not return the created item');
  });

  it('tolerates a missing item when requireItem is false', async () => {
    const bytes = new Uint8Array(16);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

    const item = await run(
      uploadSessionFragments(UPLOAD_URL, bytes, 'application/octet-stream', {
        requireItem: false,
      }),
    );
    expect(item).toEqual({});
  });
});
