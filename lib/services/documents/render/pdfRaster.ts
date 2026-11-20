/**
 * Pictures of PDF pages, made with `pdftoppm` (poppler) as a contained
 * process. Used only by the render service, which queues it like a
 * LibreOffice job: rasterizing a deck's pages takes longer than rendering
 * it (probe results in docs/POWERPOINT_TRANSLATION.md).
 */
import {
  LibreOfficeConversion,
  LibreOfficeFailedError,
  runContainedProcess,
} from './libreOfficeProcess';

import fs from 'fs';
import path from 'path';

/** CPU priority pdftoppm runs at, as LibreOffice does. */
const NICENESS = 10;

/** Largest resolution a caller may ask for. */
export const MAX_RASTER_DPI = 300;

export interface PdfRasterJob extends Pick<
  LibreOfficeConversion,
  'timeoutMs' | 'memoryLimitMb' | 'signal' | 'measureMemory'
> {
  /** The PDF; already checked to be one. */
  pdfPath: string;
  /** 1-based pages of the PDF to picture. */
  pages: number[];
  /** Resolution in dots per inch. */
  dpi: number;
  /** Where the PNGs are written (`page_<n>.png`); created if missing. */
  outputDir: string;
  /** The rasterizer to run; `pdftoppm` by default. */
  binary?: string;
}

/** The command line for one page. Arguments go to the process directly. */
export function pdfToPngCommand(
  job: Pick<PdfRasterJob, 'pdfPath' | 'dpi' | 'outputDir' | 'binary'>,
  page: number,
): { command: string; args: string[] } {
  return {
    command: 'nice',
    args: [
      '-n',
      String(NICENESS),
      job.binary ?? 'pdftoppm',
      '-png',
      '-r',
      String(job.dpi),
      '-f',
      String(page),
      '-l',
      String(page),
      '-singlefile',
      job.pdfPath,
      path.join(job.outputDir, `page_${page}`),
    ],
  };
}

/**
 * Makes a PNG of each page asked for.
 *
 * @param job - The PDF, its pages, the resolution and the limits.
 * @returns Page number to the PNG's path.
 * @throws LibreOfficeTimeoutError / LibreOfficeMemoryError past the limits
 *   (the whole job shares one time limit).
 * @throws LibreOfficeFailedError when a page produced no picture (a page
 *   the PDF does not have, or an unreadable PDF).
 */
export async function rasterizePdf(
  job: PdfRasterJob,
): Promise<Map<number, string>> {
  if (job.dpi < 1 || job.dpi > MAX_RASTER_DPI) {
    throw new RangeError(`dpi must be between 1 and ${MAX_RASTER_DPI}`);
  }
  await fs.promises.mkdir(job.outputDir, { recursive: true });
  const deadline = Date.now() + job.timeoutMs;
  const made = new Map<number, string>();
  for (const page of [...new Set(job.pages)].sort((a, b) => a - b)) {
    if (!Number.isInteger(page) || page < 1) {
      throw new RangeError(`${page} is not a page number`);
    }
    const { command, args } = pdfToPngCommand(job, page);
    const { code, signal, logs } = await runContainedProcess(command, args, {
      ...job,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    const output = path.join(job.outputDir, `page_${page}.png`);
    const produced = await fs.promises
      .stat(output)
      .then((stats) => stats.size > 0)
      .catch(() => false);
    if (!produced) {
      throw new LibreOfficeFailedError(
        `Page ${page} of the rendered document could not be pictured.`,
        signal !== null,
        logs || `exit ${code}`,
      );
    }
    made.set(page, output);
  }
  return made;
}
