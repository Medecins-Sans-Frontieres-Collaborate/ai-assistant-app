/**
 * The render service as a separate service over HTTP (RENDER_SERVICE=http):
 * the client side of the contract in docs/RENDER_SERVICE.md. Callers see
 * the same PresentationRenderService and the same errors as in process, so
 * choosing it is a configuration change.
 *
 * A job is asynchronous: it is created with its input file, followed until
 * it has run, then its output files are fetched. Aborting the caller's
 * signal cancels the job on the service.
 */
import { DocumentSignatureError, FileSignature } from './libreOfficeInputs';
import {
  LibreOfficeFailedError,
  LibreOfficeMemoryError,
  LibreOfficeTimeoutError,
} from './libreOfficeProcess';
import {
  RenderBusyError,
  RenderLane,
  RenderQueueSnapshot,
} from './renderQueue';
import type {
  PresentationRenderService,
  RenderConversionRequest,
  RenderRasterRequest,
} from './renderService';

import fs from 'fs';
import path from 'path';

/** How often a job's state is read while it waits or runs. */
export const HTTP_RENDER_POLL_MS = 500;

/** The state of a job, as `GET /jobs/:id` answers it (see the contract). */
export interface RenderJobState {
  id: string;
  state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';
  /** Jobs ahead while waiting. */
  ahead?: number;
  /** Output files when done, in order; `page` for a rasterize job. */
  files?: Array<{ name: string; page?: number }>;
  /** Why it failed: one of the contract's error codes. */
  error?: { code: string; message: string };
}

/** Where the service is and how to reach it. */
export interface HttpRenderSettings {
  /** Base address, e.g. https://render.internal (no trailing slash needed). */
  url: string;
  /** Sent as a bearer token when set. */
  token?: string;
  /** Replaced in tests. */
  fetch?: typeof fetch;
  pollMs?: number;
}

const EMPTY_SNAPSHOT: RenderQueueSnapshot = {
  running: 0,
  queued: { interactive: 0, translation: 0 },
  maxConcurrent: 1,
  averageRunMs: { interactive: null, translation: null },
};

/**
 * The error a caller would have had in process, from the contract's code.
 *
 * @param code - The error code the service sent.
 * @param message - Its message, shown to the person where the code is.
 * @param details - `type` and `found` for a signature error, `limitMb` and
 *   `timeoutMs` for memory and time limits.
 */
export function renderErrorFromCode(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Error {
  switch (code) {
    case 'RENDER_BUSY':
      return new RenderBusyError(Number(details.queued ?? 0));
    case 'DOCUMENT_PROTECTED':
    case 'DOCUMENT_UNREADABLE':
      return new DocumentSignatureError(
        String(details.type ?? ''),
        (code === 'DOCUMENT_PROTECTED'
          ? 'cfb'
          : String(details.found ?? 'unknown')) as FileSignature,
      );
    case 'RENDER_MEMORY':
      return new LibreOfficeMemoryError(Number(details.limitMb ?? 0));
    case 'RENDER_TIMEOUT':
      return new LibreOfficeTimeoutError(Number(details.timeoutMs ?? 0));
    default:
      return new LibreOfficeFailedError(message, false, '');
  }
}

/** Waits, unless the signal stops it first. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The render service reached over HTTP. */
export class HttpRenderService implements PresentationRenderService {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly pollMs: number;
  private lastSnapshot: RenderQueueSnapshot = EMPTY_SNAPSHOT;

  constructor(private readonly settings: HttpRenderSettings) {
    this.base = settings.url.replace(/\/+$/, '');
    this.fetch = settings.fetch ?? fetch;
    this.pollMs = settings.pollMs ?? HTTP_RENDER_POLL_MS;
  }

  async convert(request: RenderConversionRequest): Promise<string> {
    const [file] = await this.runJob(
      request.inputPath,
      {
        operation: 'convert',
        type: request.type,
        convertTo: request.convertTo,
        lane: request.lane,
        ...(request.timeoutMs ? { timeoutMs: String(request.timeoutMs) } : {}),
      },
      request.outputDir,
      request.lane,
      request.signal,
      request.onPosition,
    );
    if (!file)
      throw new LibreOfficeFailedError('The service sent no file', false, '');
    return file.path;
  }

  async rasterize(request: RenderRasterRequest): Promise<Map<number, string>> {
    const files = await this.runJob(
      request.pdfPath,
      {
        operation: 'rasterize',
        type: 'pdf',
        pages: request.pages.join(','),
        dpi: String(request.dpi),
        lane: request.lane,
      },
      request.outputDir,
      request.lane,
      request.signal,
      request.onPosition,
    );
    return new Map(
      files
        .filter((file) => file.page !== undefined)
        .map((file) => [file.page as number, file.path]),
    );
  }

  /**
   * The queue as last read; each call also asks for a fresh reading, so a
   * caller polling it (the job route) sees the service's queue.
   */
  snapshot(): RenderQueueSnapshot {
    void this.request('GET', '/queue')
      .then(async (response) => {
        if (response.ok)
          this.lastSnapshot = (await response.json()) as RenderQueueSnapshot;
      })
      .catch(() => undefined);
    return this.lastSnapshot;
  }

  private request(
    method: string,
    route: string,
    body?: BodyInit,
  ): Promise<Response> {
    return this.fetch(`${this.base}${route}`, {
      method,
      body,
      headers: this.settings.token
        ? { Authorization: `Bearer ${this.settings.token}` }
        : undefined,
    });
  }

  /** Reads an error answer and throws what the caller would have had. */
  private async fail(response: Response): Promise<never> {
    const parsed = (await response.json().catch(() => null)) as {
      code?: string;
      error?: string;
      details?: Record<string, unknown>;
    } | null;
    throw renderErrorFromCode(
      parsed?.code ?? 'RENDER_FAILED',
      parsed?.error ?? `The render service answered ${response.status}`,
      parsed?.details,
    );
  }

  /**
   * Creates a job, follows it to its end, and saves its files.
   *
   * @returns The output files in `outputDir`, in the service's order.
   */
  private async runJob(
    inputPath: string,
    fields: Record<string, string>,
    outputDir: string,
    lane: RenderLane,
    signal?: AbortSignal,
    onPosition?: (ahead: number) => void,
  ): Promise<Array<{ path: string; page?: number }>> {
    signal?.throwIfAborted();
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('lane', lane);
    form.append(
      'file',
      new Blob([new Uint8Array(await fs.promises.readFile(inputPath))]),
      path.basename(inputPath),
    );
    const created = await this.request('POST', '/jobs', form);
    if (created.status !== 202) await this.fail(created);
    let job = (await created.json()) as RenderJobState;
    const cancel = () =>
      void this.request('DELETE', `/jobs/${job.id}`).catch(() => undefined);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      let reported: number | undefined;
      for (;;) {
        if (job.state === 'waiting' && job.ahead !== reported) {
          reported = job.ahead;
          onPosition?.(job.ahead ?? 0);
        }
        if (job.state === 'running' && reported !== 0) {
          reported = 0;
          onPosition?.(0);
        }
        if (job.state === 'done') break;
        if (job.state === 'failed') {
          throw renderErrorFromCode(
            job.error?.code ?? 'RENDER_FAILED',
            job.error?.message ?? 'The conversion failed',
          );
        }
        if (job.state === 'cancelled')
          throw signal?.reason ?? new Error('Cancelled');
        await pause(this.pollMs, signal);
        const read = await this.request('GET', `/jobs/${job.id}`);
        if (!read.ok) await this.fail(read);
        job = (await read.json()) as RenderJobState;
      }
      await fs.promises.mkdir(outputDir, { recursive: true });
      const saved: Array<{ path: string; page?: number }> = [];
      for (const file of job.files ?? []) {
        // Only a plain name from the service reaches the disk.
        const name = path.basename(file.name);
        const response = await this.request(
          'GET',
          `/jobs/${job.id}/files/${encodeURIComponent(name)}`,
        );
        if (!response.ok) await this.fail(response);
        const target = path.join(outputDir, name);
        await fs.promises.writeFile(
          target,
          new Uint8Array(await response.arrayBuffer()),
        );
        saved.push({
          path: target,
          ...(file.page !== undefined ? { page: file.page } : {}),
        });
      }
      return saved;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
}
