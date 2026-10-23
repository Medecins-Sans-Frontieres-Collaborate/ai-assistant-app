import {
  FileTextExtractionError,
  uploadAndExtractText,
} from '@/client/services/workflows/fileTextExtraction';

import { successResponse } from '@/lib/utils/server/api/apiResponse';

import { File } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('uploadAndExtractText', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const url = '/api/file/document.pdf';
  const file = new File(['document'], 'document.pdf', {
    type: 'application/pdf',
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'FileReader',
      class {
        result = 'data:application/pdf;base64,ZG9jdW1lbnQ=';
        onloadend?: () => void;
        readAsDataURL() {
          this.onloadend?.();
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the URL from the server success envelope to extraction', async () => {
    // Use the same response helper as /api/file/upload so this guards the
    // client/server contract rather than inventing a client-shaped fixture.
    fetchMock
      .mockResolvedValueOnce(successResponse({ uri: url }))
      .mockResolvedValueOnce(
        Response.json({ results: [{ url, content: 'Extracted document' }] }),
      );

    await expect(uploadAndExtractText(file)).resolves.toEqual({
      url,
      name: file.name,
      text: 'Extracted document',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/file/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  });

  it.each([
    null,
    {},
    { uri: url },
    { data: {} },
    { data: { uri: ' ' } },
    { data: { uri: 42 } },
  ])(
    'rejects an upload response without a valid nested URL: %j',
    async (body) => {
      fetchMock.mockResolvedValueOnce(Response.json(body));

      await expect(uploadAndExtractText(file)).rejects.toThrow(
        'Upload failed: server response is missing the file URL',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, {}, { results: [] }, { results: [{}] }])(
    'distinguishes a missing extraction result from an empty document: %j',
    async (body) => {
      fetchMock
        .mockResolvedValueOnce(successResponse({ uri: url }))
        .mockResolvedValueOnce(Response.json(body));

      await expect(uploadAndExtractText(file)).rejects.toThrow(
        'Text extraction failed: server response is missing the result',
      );
    },
  );

  it('preserves genuinely empty extracted text for the workspace to handle', async () => {
    fetchMock
      .mockResolvedValueOnce(successResponse({ uri: url }))
      .mockResolvedValueOnce(
        Response.json({ results: [{ url, content: '' }] }),
      );

    await expect(uploadAndExtractText(file)).resolves.toMatchObject({
      text: '',
    });
  });

  it('surfaces upload errors without attempting extraction', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: 'Storage unavailable' }, { status: 503 }),
    );

    await expect(uploadAndExtractText(file)).rejects.toThrow(
      'Storage unavailable',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces converter errors from the processing endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(successResponse({ uri: url }))
      .mockResolvedValueOnce(
        Response.json({ error: 'spawn pandoc ENOENT' }, { status: 500 }),
      );

    await expect(uploadAndExtractText(file)).rejects.toThrow(
      'spawn pandoc ENOENT',
    );
  });

  it('preserves the no-text error code for localized workspace handling', async () => {
    fetchMock
      .mockResolvedValueOnce(successResponse({ uri: url }))
      .mockResolvedValueOnce(
        Response.json(
          {
            error:
              'The PDF contains no extractable text (scanned or image-only?)',
            code: 'NO_EXTRACTABLE_TEXT',
          },
          { status: 422 },
        ),
      );

    const result = uploadAndExtractText(file);
    await expect(result).rejects.toBeInstanceOf(FileTextExtractionError);
    await expect(result).rejects.toMatchObject({ code: 'NO_EXTRACTABLE_TEXT' });
  });

  it('reads plain text locally without requiring upload or extraction', async () => {
    const textFile = new File(['Translate this'], 'notes.txt', {
      type: 'text/plain',
    });

    await expect(uploadAndExtractText(textFile)).resolves.toEqual({
      url: '',
      name: 'notes.txt',
      text: 'Translate this',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('extracts PDFs on the server even if the browser supplies a plain-text MIME type', async () => {
    const mislabeledPdf = new File(['%PDF-1.4'], 'source.PDF', {
      type: 'text/plain',
    });
    fetchMock
      .mockResolvedValueOnce(successResponse({ uri: url }))
      .mockResolvedValueOnce(
        Response.json({ results: [{ url, content: 'Parsed PDF text' }] }),
      );
    await expect(uploadAndExtractText(mislabeledPdf)).resolves.toMatchObject({
      text: 'Parsed PDF text',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
