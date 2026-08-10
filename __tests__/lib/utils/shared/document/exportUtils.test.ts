import { fetchDocxBlob } from '@/lib/utils/shared/document/exportUtils';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock getDOMPurify (imported by the module) to avoid jsdom initialization.
vi.mock('@/lib/utils/shared/document/domPurify', () => ({
  getDOMPurify: vi.fn().mockResolvedValue({
    sanitize: (html: string) => html,
  }),
}));

function jsonErrorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob()),
  } as unknown as Response;
}

describe('fetchDocxBlob', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the response blob on success', async () => {
    const blob = new Blob(['docx-bytes']);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(blob),
    } as unknown as Response);

    await expect(fetchDocxBlob('<p>hi</p>')).resolves.toBe(blob);
  });

  it('surfaces the server error message from the apiResponse body', async () => {
    fetchMock.mockResolvedValue(
      jsonErrorResponse(400, { error: 'Invalid HTML content' }),
    );

    await expect(fetchDocxBlob('<p>hi</p>')).rejects.toThrow(
      'Failed to convert to DOCX: Invalid HTML content',
    );
  });

  it('includes the error code when the body carries one', async () => {
    fetchMock.mockResolvedValue(
      jsonErrorResponse(500, {
        error: 'Conversion crashed',
        code: 'DOCX_CONVERSION_ERROR',
      }),
    );

    await expect(fetchDocxBlob('<p>hi</p>')).rejects.toThrow(
      'Failed to convert to DOCX: Conversion crashed [DOCX_CONVERSION_ERROR]',
    );
  });

  it('falls back to an HTTP-status message when the body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response);

    await expect(fetchDocxBlob('<p>hi</p>')).rejects.toThrow(
      'Failed to convert to DOCX (HTTP 502)',
    );
  });

  it('ignores a malformed error body (non-string error field)', async () => {
    fetchMock.mockResolvedValue(
      jsonErrorResponse(500, { error: { nested: true } }),
    );

    await expect(fetchDocxBlob('<p>hi</p>')).rejects.toThrow(
      'Failed to convert to DOCX (HTTP 500)',
    );
  });
});
