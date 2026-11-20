import { DocumentSignatureError } from '@/lib/services/documents/render/libreOfficeInputs';
import { LibreOfficeFailedError } from '@/lib/services/documents/render/libreOfficeProcess';
import { rasterizePdf } from '@/lib/services/documents/render/pdfRaster';
import { RenderBusyError } from '@/lib/services/documents/render/renderQueue';
import { InProcessRenderService } from '@/lib/services/documents/render/renderService';

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Pictures of PDF pages: queued like a conversion, checked to be a PDF
 * before waiting, and made by pdftoppm as a contained process.
 */

vi.mock('@/config/environment', () => ({ env: {} }));

let dir: string;
let pdf: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-raster-test-'));
  pdf = path.join(dir, 'two.pdf');
  // A two-page PDF, written by hand: 72 x 36 pt pages.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 36] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 36] >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(pdf, body);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const settings = {
  maxConcurrent: 1,
  maxQueued: 0,
  interactiveBurst: 3,
  memoryLimitMb: 1024,
  timeoutBaseMs: 60_000,
  timeoutPerMbMs: 0,
  timeoutMaxMs: 600_000,
  workRoot: '',
};

describe('rasterize through the render service', () => {
  it('waits in the queue like a conversion and is refused when it is full', async () => {
    let release!: () => void;
    const raster = vi.fn(
      () =>
        new Promise<Map<number, string>>(
          (resolve) => (release = () => resolve(new Map())),
        ),
    );
    const service = new InProcessRenderService(
      { ...settings, workRoot: dir },
      vi.fn(),
      raster,
    );
    const first = service.rasterize({
      pdfPath: pdf,
      pages: [1],
      dpi: 72,
      outputDir: dir,
      lane: 'translation',
    });
    await vi.waitFor(() => expect(raster).toHaveBeenCalled());
    await expect(
      service.rasterize({
        pdfPath: pdf,
        pages: [2],
        dpi: 72,
        outputDir: dir,
        lane: 'translation',
      }),
    ).rejects.toBeInstanceOf(RenderBusyError);
    release();
    await first;
  });

  it('refuses a file that is not a PDF before waiting', async () => {
    const junk = path.join(dir, 'junk.pdf');
    fs.writeFileSync(junk, 'not a pdf');
    const raster = vi.fn();
    const service = new InProcessRenderService(
      { ...settings, workRoot: dir },
      vi.fn(),
      raster,
    );
    await expect(
      service.rasterize({
        pdfPath: junk,
        pages: [1],
        dpi: 72,
        outputDir: dir,
        lane: 'translation',
      }),
    ).rejects.toBeInstanceOf(DocumentSignatureError);
    expect(raster).not.toHaveBeenCalled();
  });
});

const hasPdftoppm = (() => {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPdftoppm)('rasterizePdf with the real pdftoppm', () => {
  it('pictures each page asked for at the resolution asked for', async () => {
    const made = await rasterizePdf({
      pdfPath: pdf,
      pages: [2, 1],
      dpi: 144,
      outputDir: path.join(dir, 'real'),
      timeoutMs: 60_000,
      memoryLimitMb: 1024,
    });
    expect([...made.keys()]).toEqual([1, 2]);
    const meta = await sharp(made.get(2)!).metadata();
    expect([meta.width, meta.height]).toEqual([144, 72]);
  });

  it('fails for a page the PDF does not have', async () => {
    await expect(
      rasterizePdf({
        pdfPath: pdf,
        pages: [3],
        dpi: 72,
        outputDir: path.join(dir, 'missing'),
        timeoutMs: 60_000,
        memoryLimitMb: 1024,
      }),
    ).rejects.toBeInstanceOf(LibreOfficeFailedError);
  });

  it('refuses a resolution past the limit', async () => {
    await expect(
      rasterizePdf({
        pdfPath: pdf,
        pages: [1],
        dpi: 1200,
        outputDir: dir,
        timeoutMs: 1000,
        memoryLimitMb: 64,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
