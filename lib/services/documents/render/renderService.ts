/**
 * THE RENDER SERVICE: the only way the server runs LibreOffice.
 *
 * Every conversion (chat attachments read as text, file previews, document
 * translation, brand review) waits in one queue (RenderQueue) so the number of
 * LibreOffice processes on an instance never exceeds RENDER_MAX_CONCURRENT,
 * whatever arrives at once. Waiting is cheap and expected: background work
 * already tells the person it takes a while.
 *
 * Callers use the `PresentationRenderService` interface only. The
 * in-process implementation runs LibreOffice on this server; a separate
 * service replaces it by configuration (RENDER_SERVICE=http, see
 * httpRenderService.ts) without callers changing. The contract is written
 * down in docs/RENDER_SERVICE.md.
 */
import { HttpRenderService } from './httpRenderService';
import {
  DocumentSignatureError,
  LibreOfficeInputType,
  checkLibreOfficeInput,
  readSignature,
} from './libreOfficeInputs';
import {
  LibreOfficeConversion,
  LibreOfficeFailedError,
  runLibreOffice,
} from './libreOfficeProcess';
import { PdfRasterJob, rasterizePdf } from './pdfRaster';
import {
  RenderLane,
  RenderQueue,
  RenderQueueObserver,
  RenderQueueSnapshot,
} from './renderQueue';

import { env } from '@/config/environment';
import { metrics } from '@opentelemetry/api';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** One conversion. */
export interface RenderConversionRequest {
  /** The file to convert. */
  inputPath: string;
  /**
   * What the file is (extension without the dot); checked against its
   * first bytes and used to pick the import filter.
   */
  type: LibreOfficeInputType | string;
  /** `--convert-to` argument: `pdf`, `pptx`, or with filter options. */
  convertTo: string;
  /** Where the output is written. */
  outputDir: string;
  /** Which line to wait in; see LANES in renderQueue. */
  lane: RenderLane;
  /** Stops waiting, or stops the conversion. */
  signal?: AbortSignal;
  /** Told how many jobs are ahead while waiting (0 when it starts). */
  onPosition?: (ahead: number) => void;
  /** Overrides the time limit derived from the file's size. */
  timeoutMs?: number;
}

/** Pictures of a PDF's pages. */
export interface RenderRasterRequest {
  /** The PDF. */
  pdfPath: string;
  /** 1-based pages to picture. */
  pages: number[];
  /** Resolution in dots per inch (at most MAX_RASTER_DPI). */
  dpi: number;
  /** Where the PNGs are written. */
  outputDir: string;
  lane: RenderLane;
  signal?: AbortSignal;
  onPosition?: (ahead: number) => void;
}

/** What callers may rely on, in process or as a separate service. */
export interface PresentationRenderService {
  /**
   * Converts one document once a slot is free.
   *
   * @returns Path of the converted file in `outputDir`.
   * @throws DocumentSignatureError when the file is not its declared type
   *   (before waiting; nothing is queued).
   * @throws RenderBusyError when the queue is full.
   * @throws LibreOfficeTimeoutError, LibreOfficeFailedError on failure.
   */
  convert(request: RenderConversionRequest): Promise<string>;
  /**
   * Pictures pages of a PDF once a slot is free; waits in the same queue
   * as conversions.
   *
   * @returns Page number to the PNG's path in `outputDir`.
   * @throws DocumentSignatureError when the file is not a PDF.
   * @throws RenderBusyError when the queue is full.
   * @throws LibreOfficeTimeoutError, LibreOfficeFailedError on failure.
   */
  rasterize(request: RenderRasterRequest): Promise<Map<number, string>>;
  /** Jobs running and waiting, by lane. */
  snapshot(): RenderQueueSnapshot;
}

/** Settings of the in-process service; see RENDER_* in config. */
export interface InProcessRenderSettings {
  maxConcurrent: number;
  maxQueued: number;
  interactiveBurst: number;
  memoryLimitMb: number;
  timeoutBaseMs: number;
  timeoutPerMbMs: number;
  timeoutMaxMs: number;
  /** Where profiles live; leftovers older than STALE_WORK_MS are removed. */
  workRoot: string;
}

/** Work directories older than this are leftovers of a crash or restart. */
export const STALE_WORK_MS = 60 * 60 * 1000;

/** Attempts per conversion: a crash is tried once more with a new profile. */
const ATTEMPTS = 2;

/**
 * Time limit for a file of `bytes`: the base plus a share per megabyte,
 * capped. A 37 MB, 60-slide deck takes 6-8 s; the defaults allow minutes,
 * which only a stuck process uses up.
 */
export function timeLimitFor(
  bytes: number,
  settings: Pick<
    InProcessRenderSettings,
    'timeoutBaseMs' | 'timeoutPerMbMs' | 'timeoutMaxMs'
  >,
): number {
  const megabytes = bytes / (1024 * 1024);
  return Math.min(
    settings.timeoutMaxMs,
    Math.round(settings.timeoutBaseMs + megabytes * settings.timeoutPerMbMs),
  );
}

/** Metrics on the app's meter; App Insights charts them. */
function renderMetrics(service: () => PresentationRenderService) {
  const meter = metrics.getMeter('msf-ai-assistant-metrics');
  const jobs = meter.createCounter('render.jobs', {
    description: 'LibreOffice jobs by lane and outcome',
  });
  const refused = meter.createCounter('render.refused', {
    description: 'LibreOffice jobs refused because the queue was full',
  });
  const waited = meter.createHistogram('render.queue_wait', {
    description: 'Time a LibreOffice job waited for a slot',
    unit: 'ms',
  });
  const ran = meter.createHistogram('render.run_time', {
    description: 'Time a LibreOffice job ran, retries included',
    unit: 'ms',
  });
  const failures = meter.createCounter('render.failures', {
    description: 'LibreOffice timeouts and crashes',
  });
  const depth = meter.createObservableGauge('render.queue_depth', {
    description: 'LibreOffice jobs waiting, by lane',
  });
  depth.addCallback((result) => {
    const { queued } = service().snapshot();
    result.observe(queued.interactive, { lane: 'interactive' });
    result.observe(queued.background, { lane: 'background' });
  });
  const observer: RenderQueueObserver = {
    onRefused: (lane) => refused.add(1, { lane }),
    onStart: (lane, waitedMs) => waited.record(waitedMs, { lane }),
    onFinish: (lane, ranMs, outcome) => {
      ran.record(ranMs, { lane });
      jobs.add(1, { lane, outcome });
    },
  };
  const failure = (kind: 'timeout' | 'crash' | 'unreadable') =>
    failures.add(1, { kind });
  return { observer, failure };
}

/**
 * Runs LibreOffice on this server, one queue for the instance.
 */
export class InProcessRenderService implements PresentationRenderService {
  private readonly queue: RenderQueue;
  private readonly recordFailure: (
    kind: 'timeout' | 'crash' | 'unreadable',
  ) => void;

  /**
   * @param settings - Limits; see RENDER_* in config/environment.ts.
   * @param run - Runs one conversion; replaced in tests.
   */
  constructor(
    private readonly settings: InProcessRenderSettings,
    private readonly run: (
      job: LibreOfficeConversion,
    ) => Promise<string> = runLibreOffice,
    private readonly raster: (
      job: PdfRasterJob,
    ) => Promise<Map<number, string>> = rasterizePdf,
  ) {
    const { observer, failure } = renderMetrics(() => this);
    this.recordFailure = failure;
    this.queue = new RenderQueue({
      maxConcurrent: settings.maxConcurrent,
      maxQueued: settings.maxQueued,
      interactiveBurst: settings.interactiveBurst,
      observer,
    });
  }

  snapshot() {
    return this.queue.snapshot();
  }

  async convert(request: RenderConversionRequest): Promise<string> {
    // Checked before waiting: a file that is not what it says never
    // takes a place in the queue.
    const input = await checkLibreOfficeInput(request.inputPath, request.type);
    const { size } = await fs.promises.stat(request.inputPath);
    const timeoutMs = request.timeoutMs ?? timeLimitFor(size, this.settings);

    return this.queue.run(
      request.lane,
      async (signal) => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
          const workDir = path.join(
            this.settings.workRoot,
            `job-${randomUUID()}`,
          );
          try {
            return await this.run({
              inputPath: request.inputPath,
              importFilter: input.filter,
              convertTo: request.convertTo,
              outputDir: request.outputDir,
              profileDir: path.join(workDir, 'profile'),
              timeoutMs,
              memoryLimitMb: this.settings.memoryLimitMb,
              signal,
            });
          } catch (error) {
            lastError = error;
            const crashed =
              error instanceof LibreOfficeFailedError && error.crashed;
            if (error instanceof LibreOfficeFailedError) {
              this.recordFailure(crashed ? 'crash' : 'unreadable');
            } else if (
              (error as { code?: string })?.code === 'RENDER_TIMEOUT'
            ) {
              this.recordFailure('timeout');
            }
            console.warn(
              `[render] ${request.type} -> ${request.convertTo} attempt ${attempt} failed: ${(error as Error)?.message}`,
            );
            // Only a crash is worth another try; a file LibreOffice
            // cannot read, a timeout or an abort would fail the same way.
            if (!crashed || signal?.aborted) throw error;
          } finally {
            await fs.promises
              .rm(workDir, { recursive: true, force: true })
              .catch(() => undefined);
          }
        }
        throw lastError;
      },
      { signal: request.signal, onPosition: request.onPosition },
    );
  }

  async rasterize(request: RenderRasterRequest): Promise<Map<number, string>> {
    const found = await readSignature(request.pdfPath);
    if (found !== 'pdf') throw new DocumentSignatureError('pdf', found);
    const { size } = await fs.promises.stat(request.pdfPath);
    // A picture per page; the time limit grows with the pages asked for.
    const timeoutMs = Math.min(
      this.settings.timeoutMaxMs,
      timeLimitFor(size, this.settings) * Math.max(1, request.pages.length),
    );
    return this.queue.run(
      request.lane,
      (signal) =>
        this.raster({
          pdfPath: request.pdfPath,
          pages: request.pages,
          dpi: request.dpi,
          outputDir: request.outputDir,
          timeoutMs,
          memoryLimitMb: this.settings.memoryLimitMb,
          signal,
        }),
      { signal: request.signal, onPosition: request.onPosition },
    );
  }

  /**
   * Removes work directories a crash or restart left behind. Only those
   * older than STALE_WORK_MS: a running job's directory is younger.
   */
  async removeLeftovers(now: number = Date.now()): Promise<number> {
    const entries = await fs.promises
      .readdir(this.settings.workRoot, { withFileTypes: true })
      .catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;
      const full = path.join(this.settings.workRoot, entry.name);
      const stats = await fs.promises.stat(full).catch(() => null);
      if (!stats || now - stats.mtimeMs < STALE_WORK_MS) continue;
      await fs.promises.rm(full, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}

/** The service's settings from the environment. */
export function renderSettingsFromEnv(): InProcessRenderSettings {
  return {
    maxConcurrent: env.RENDER_MAX_CONCURRENT,
    maxQueued: env.RENDER_MAX_QUEUED,
    interactiveBurst: env.RENDER_INTERACTIVE_BURST,
    memoryLimitMb: env.RENDER_MEMORY_LIMIT_MB,
    timeoutBaseMs: env.RENDER_TIMEOUT_BASE_MS,
    timeoutPerMbMs: env.RENDER_TIMEOUT_PER_MB_MS,
    timeoutMaxMs: env.RENDER_TIMEOUT_MAX_MS,
    workRoot: path.join(os.tmpdir(), 'render-service'),
  };
}

// One service per process. Kept on globalThis because the dev server
// reloads modules: a second queue would double the concurrency limit.
const SERVICE_KEY = Symbol.for('ai-assistant.render-service');
type Holder = { [SERVICE_KEY]?: PresentationRenderService };

/**
 * The render service for this process, chosen by RENDER_SERVICE. Made on
 * first use, which also removes leftovers of an earlier process.
 */
export function getRenderService(): PresentationRenderService {
  const holder = globalThis as Holder;
  const existing = holder[SERVICE_KEY];
  if (existing) return existing;
  if (env.RENDER_SERVICE === 'http') {
    if (!env.RENDER_SERVICE_URL) {
      throw new Error(
        'RENDER_SERVICE is http but RENDER_SERVICE_URL is not set',
      );
    }
    const remote = new HttpRenderService({
      url: env.RENDER_SERVICE_URL,
      token: env.RENDER_SERVICE_TOKEN,
    });
    holder[SERVICE_KEY] = remote;
    return remote;
  }
  const settings = renderSettingsFromEnv();
  const service = new InProcessRenderService(settings);
  void service
    .removeLeftovers()
    .then((count) => {
      if (count > 0)
        console.log(`[render] removed ${count} leftover work directories`);
    })
    .catch(() => undefined);
  holder[SERVICE_KEY] = service;
  return service;
}
