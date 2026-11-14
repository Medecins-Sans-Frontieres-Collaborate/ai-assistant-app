import {
  FileTextExtractionError,
  ocrUploadedFile,
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
      ocrAvailable: false,
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
      ocrAvailable: false,
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

describe('OCR in the extraction service', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const url = '/api/file/scan.pdf';
  const file = new File(['scan'], 'scan.pdf', { type: 'application/pdf' });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'FileReader',
      class {
        result = 'data:application/pdf;base64,c2Nhbg==';
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

  it('reports whether the server offers OCR for an extracted file', async () => {
    fetchMock
      .mockResolvedValueOnce(successResponse({ uri: url }))
      .mockResolvedValueOnce(
        Response.json({ results: [{ content: 'thin' }], ocrAvailable: true }),
      );
    await expect(uploadAndExtractText(file)).resolves.toMatchObject({
      ocrAvailable: true,
    });
  });

  it('keeps the stored file and the OCR offer on a no-text failure', async () => {
    fetchMock
      .mockResolvedValueOnce(successResponse({ uri: url }))
      .mockResolvedValueOnce(
        Response.json(
          { error: 'none', code: 'NO_EXTRACTABLE_TEXT', ocrAvailable: true },
          { status: 422 },
        ),
      );
    const error = await uploadAndExtractText(file).catch((e) => e);
    expect(error).toBeInstanceOf(FileTextExtractionError);
    expect(error.code).toBe('NO_EXTRACTABLE_TEXT');
    expect(error.context).toEqual({ url, ocrAvailable: true, status: 422 });
  });

  it('does not claim OCR when the server does not say so', async () => {
    fetchMock
      .mockResolvedValueOnce(successResponse({ uri: url }))
      .mockResolvedValueOnce(
        Response.json({ error: 'none', code: 'X' }, { status: 422 }),
      );
    const error = await uploadAndExtractText(file).catch((e) => e);
    expect(error.context.ocrAvailable).toBe(false);
  });

  it('returns OCR text and the pages read', async () => {
    fetchMock.mockResolvedValueOnce(
      successResponse({ content: '--- Page 1 ---\nTexto', pageCount: 3 }),
    );
    await expect(ocrUploadedFile(url)).resolves.toEqual({
      text: '--- Page 1 ---\nTexto',
      pageCount: 3,
    });
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe('/api/file/ocr');
    expect(JSON.parse(init?.body as string)).toEqual({ url });
  });

  it('carries the server code and status when OCR is refused', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: 'Too long', code: 'OCR_TOO_MANY_PAGES' },
        { status: 413 },
      ),
    );
    const error = await ocrUploadedFile(url).catch((e) => e);
    expect(error).toBeInstanceOf(FileTextExtractionError);
    expect(error).toMatchObject({
      message: 'Too long',
      code: 'OCR_TOO_MANY_PAGES',
      context: { url, status: 413 },
    });
  });

  it('rejects a success response without the text', async () => {
    fetchMock.mockResolvedValueOnce(successResponse({ pageCount: 3 }));
    await expect(ocrUploadedFile(url)).rejects.toThrow(
      'OCR failed: server response is missing the result',
    );
  });
});
