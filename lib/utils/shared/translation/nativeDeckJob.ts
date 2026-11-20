import type { NativeDeckFormat } from './nativeFormats';
import type {
  NativePdfBrief,
  NativePdfRenderReport,
  NativePdfRunReport,
  NativePdfStepId,
} from './nativePdf';
import type { NativeRunBackend } from './nativeRunStorage';

/**
 * What the browser sees of a presentation translated in the background
 * (THE JOB CONVENTION in lib/services/documentTranslation/native/
 * deckRunJob.ts), and the wait it is shown while queued.
 */

export type NativeDeckJobStatus = 'running' | 'done' | 'failed' | 'stopped';

/** One step of the batch in progress. */
export interface NativeDeckJobStep {
  id: NativePdfStepId;
  status: 'upcoming' | 'active' | 'done' | 'skipped';
  detail?: string;
  durationMs?: number;
}

/** A finished batch: its report, with the tokens it used. */
export type NativeDeckJobPiece = NativePdfRunReport & {
  usage?: { totalTokens?: number };
};

/** A job as `GET /api/document-translation/native/job` answers it. */
export interface NativeDeckJobView {
  jobId: string;
  runId: string;
  backend: NativeRunBackend;
  status: NativeDeckJobStatus;
  /** Finished batches, in order. */
  pieces: NativeDeckJobPiece[];
  brief?: NativePdfBrief;
  /** The batch in progress. */
  current?: {
    /** 1-based batch. */
    part: number;
    steps: NativeDeckJobStep[];
    /** Jobs ahead in the render queue while it waits for a slot. */
    queueAhead?: number;
  };
  /** The batches joined into one document, when there were several. */
  assembled?: NativePdfRenderReport;
  startedAt: number;
  heartbeatAt: number;
  /** Times it was picked up again after the server restarted. */
  resumes: number;
  stopRequested?: boolean;
  error?: string;
  sourceName: string;
  format: NativeDeckFormat;
  /** Set when the upload was a `.ppt`, converted before the run. */
  convertedFrom?: 'ppt';
  /** The deck was damaged and LibreOffice repaired it (it is now a .pptx). */
  repaired?: boolean;
  targetLanguage: string;
  /** Batches the job takes. */
  parts: number;
  /** Slides it translates. */
  pageCount: number;
  translateNotes: boolean;
}

/** The render queue as the job route reports it. */
export interface NativeDeckQueue {
  running: number;
  queued: { interactive: number; background: number };
  maxConcurrent: number;
  averageRunMs: { interactive: number | null; background: number | null };
}

/**
 * How long a job with `ahead` jobs before it may wait for a slot: the
 * rounds of `maxConcurrent` jobs ahead of it, each taking the background
 * lane's average.
 *
 * @param ahead - Jobs ahead (`current.queueAhead`).
 * @param queue - The queue the job waits in.
 * @returns Milliseconds; null when nothing is ahead or no job has finished
 *   yet to go by.
 * @example queueWaitEstimateMs(4, { maxConcurrent: 2, averageRunMs: { background: 30_000 } }) // 60_000
 */
export function queueWaitEstimateMs(
  ahead: number,
  queue: Pick<NativeDeckQueue, 'maxConcurrent' | 'averageRunMs'>,
): number | null {
  const average = queue.averageRunMs.background;
  if (!(ahead > 0) || average === null || !(average > 0)) return null;
  const rounds = Math.ceil(ahead / Math.max(1, queue.maxConcurrent));
  return rounds * average;
}
