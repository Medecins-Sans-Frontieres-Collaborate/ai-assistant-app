import { NextRequest } from 'next/server';

import { FileProcessingService } from '@/lib/services/chat/FileProcessingService';

import { countPdfPages } from '@/lib/utils/server/file/fileHandling';
import {
  getPdfPageCount,
  getPdfPageCountFromBuffer,
} from '@/lib/utils/server/file/pdfUtils';

import { POST } from '@/app/api/file/process/route';
import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  blobs: new Map<string, Buffer>(),
  get: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock('@/auth', () => ({
  auth: async () => ({ user: { id: 'audit-user' }, expires: '' }),
}));
vi.mock('@/lib/utils/app/user/session', () => ({
  getUserIdFromSession: () => 'audit-user',
}));
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: () => ({
    blobExists: async (key: string) => mocks.blobs.has(key),
    get: mocks.get,
  }),
}));
// Keep the real PDF parser and filesystem. Stub only external converters so
// this contract suite also runs on hosts without Poppler/Ghostscript.
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      opts: unknown,
      cb: (
        error: Error | null,
        result?: { stdout: string; stderr: string },
      ) => void,
    ) => {
      Promise.resolve()
        .then(() => mocks.execFile(cmd, args, opts))
        .then(
          (result) => cb(null, result),
          (error) => cb(error),
        );
    },
  };
});

let tempDirectory: string;
const blobKey = (name: string) => `audit-user/uploads/files/${name}`;

async function processFile(name = 'document.pdf') {
  return POST(
    new NextRequest('http://localhost/api/file/process', {
      method: 'POST',
      body: JSON.stringify({ url: `/api/file/${name}` }),
    }),
  );
}

async function pdfBytes(text?: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  if (text) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { font });
  } else {
    // Visible graphical content with no text layer, like a scanned page.
    page.drawRectangle({ x: 10, y: 10, width: 100, height: 100 });
  }
  return Buffer.from(await pdf.save());
}

beforeEach(async () => {
  mocks.blobs.clear();
  mocks.get.mockReset().mockImplementation(async (key: string) => {
    const value = mocks.blobs.get(key);
    if (!value) throw new Error('Blob unavailable');
    return value;
  });
  mocks.execFile.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  await fs.promises.mkdir('/tmp/opencode', { recursive: true });
  tempDirectory = await fs.promises.mkdtemp('/tmp/opencode/pdf-process-');
  vi.spyOn(
    FileProcessingService.prototype,
    'getTempFilePath',
  ).mockImplementation((url) => {
    const name = url.split('/').pop()!;
    return [name, path.join(tempDirectory, name)];
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(tempDirectory, { recursive: true, force: true });
});

describe('PDF processing contract with real PDF.js and cache downloads', () => {
  it('keeps the PDF parser usable after every page-counting path', async () => {
    const bytes = await pdfBytes('Readable after page counting.');
    const filePath = path.join(tempDirectory, 'count.pdf');
    await fs.promises.writeFile(filePath, bytes);
    await expect(getPdfPageCount(filePath)).resolves.toBe(1);
    await expect(getPdfPageCountFromBuffer(bytes)).resolves.toBe(1);
    await expect(countPdfPages(bytes)).resolves.toBe(1);
    mocks.blobs.set(blobKey('document.pdf'), bytes);
    const response = await processFile();
    expect(response.status).toBe(200);
    expect((await response.json()).results[0].content).toContain(
      'Readable after page counting.',
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('returns every result when a batch of cached files completes together', async () => {
    vi.spyOn(
      FileProcessingService.prototype,
      'downloadFilePreferCached',
    ).mockResolvedValue({ usedCache: true });
    vi.spyOn(FileProcessingService.prototype, 'readFile').mockResolvedValue(
      Buffer.from('Cached text.'),
    );
    vi.spyOn(
      FileProcessingService.prototype,
      'cleanupFile',
    ).mockResolvedValue();
    const urls = Array.from(
      { length: 7 },
      (_, n) => `/api/file/source-${n}.pdf`,
    );
    const response = await POST(
      new NextRequest('http://localhost/api/file/process', {
        method: 'POST',
        body: JSON.stringify(urls.map((url) => ({ url }))),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.map((result: { url: string }) => result.url)).toEqual(
      urls,
    );
  });

  it('extracts a normal PDF without requiring CLI fallback and cleans up', async () => {
    mocks.blobs.set(
      blobKey('document.pdf'),
      await pdfBytes('Translate this sentence.'),
    );
    const response = await processFile();
    expect(response.status).toBe(200);
    expect((await response.json()).results[0].content).toContain(
      'Translate this sentence.',
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(await fs.promises.readdir(tempDirectory)).toEqual([]);
  });

  it('classifies a PDF without a text layer as no text and cleans up', async () => {
    mocks.blobs.set(blobKey('document.pdf'), await pdfBytes());
    const response = await processFile();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: 'NO_EXTRACTABLE_TEXT',
    });
    expect(mocks.execFile.mock.calls.map(([cmd]) => cmd)).toEqual([
      'pdftotext',
    ]);
    expect(await fs.promises.readdir(tempDirectory)).toEqual([]);
  });

  it.each(['', ' \n\t', '\uFFFD'.repeat(60), '--- Page 1 ---\n\u0001\u0002'])(
    're-extracts a PDF when cached text is unusable: %j',
    async (cached) => {
      mocks.blobs.set(
        blobKey('document.pdf'),
        await pdfBytes('Fresh readable source.'),
      );
      mocks.blobs.set(
        `${blobKey('document.pdf')}.cached.txt`,
        Buffer.from(cached),
      );
      const response = await processFile();
      expect(response.status).toBe(200);
      expect((await response.json()).results[0].content).toContain(
        'Fresh readable source.',
      );
      expect(mocks.get).toHaveBeenCalledWith(
        blobKey('document.pdf'),
        expect.anything(),
      );
    },
  );

  it('uses valid cached text without downloading the original PDF', async () => {
    mocks.blobs.set(
      `${blobKey('document.pdf')}.cached.txt`,
      Buffer.from('Cached readable text.'),
    );
    const response = await processFile();
    expect(response.status).toBe(200);
    expect((await response.json()).results[0].content).toBe(
      'Cached readable text.',
    );
    expect(mocks.get).not.toHaveBeenCalledWith(
      blobKey('document.pdf'),
      expect.anything(),
    );
  });

  it('keeps corrupt-PDF failures distinct from no-text outcomes and cleans up', async () => {
    mocks.blobs.set(blobKey('document.pdf'), Buffer.from('%PDF-1.4 broken'));
    mocks.execFile.mockRejectedValue(new Error('Invalid PDF structure'));
    const response = await processFile();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'PROCESSING_FAILED' });
    expect(await fs.promises.readdir(tempDirectory)).toEqual([]);
  });

  it('waits for in-flight batch processing to clean up before returning an error', async () => {
    let started = 0;
    let finishOther!: () => void;
    const otherFinished = new Promise<void>((resolve) => {
      finishOther = resolve;
    });
    const cleaned: string[] = [];
    vi.spyOn(
      FileProcessingService.prototype,
      'downloadFilePreferCached',
    ).mockImplementation(async (url) => {
      started += 1;
      if (url.endsWith('bad.pdf')) throw new Error('Download failed');
      await otherFinished;
      return { usedCache: true };
    });
    vi.spyOn(FileProcessingService.prototype, 'readFile').mockResolvedValue(
      Buffer.from('Cached text.'),
    );
    vi.spyOn(FileProcessingService.prototype, 'cleanupFile').mockImplementation(
      async (filePath) => {
        cleaned.push(path.basename(filePath));
      },
    );
    let responded = false;
    const responsePromise = POST(
      new NextRequest('http://localhost/api/file/process', {
        method: 'POST',
        body: JSON.stringify([
          { url: '/api/file/bad.pdf' },
          { url: '/api/file/good.pdf' },
        ]),
      }),
    ).then((response) => {
      responded = true;
      return response;
    });
    await vi.waitFor(() => expect(started).toBe(2));
    expect(responded).toBe(false);
    finishOther();
    expect((await responsePromise).status).toBe(500);
    expect(cleaned.sort()).toEqual(['bad.pdf', 'good.pdf']);
  });
});
