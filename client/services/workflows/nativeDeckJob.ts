'use client';

import {
  RunAccess,
  runErrorFrom,
  runKeyHeaders,
} from '@/client/services/workflows/nativeRunStorage';
import { recordWorkflowUsage } from '@/client/services/workflows/workflowUsageRecorder';

import {
  NativeDeckJobView,
  NativeDeckQueue,
} from '@/lib/utils/shared/translation/nativeDeckJob';
import {
  NativePdfBrief,
  NativePdfDepth,
  NativePdfStepInstructions,
} from '@/lib/utils/shared/translation/nativePdf';

import { NativePdfGlossaries } from './nativePdfTranslation';

/**
 * The browser's side of a presentation translated in the background (THE
 * JOB CONVENTION in deckRunJob.ts): start it, read its progress, stop it.
 * The work goes on on the server whether or not this page is open.
 */

const JOB_ROUTE = '/api/document-translation/native/job';

/** The code the server answers while the person has another deck running. */
export const DECK_RUN_ACTIVE = 'DECK_RUN_ACTIVE';

/** Another of the person's presentations is still being translated. */
export class DeckRunBusyError extends Error {
  constructor(
    /** The file name of the presentation in progress. */
    readonly activeName: string,
  ) {
    super(`"${activeName}" is still being translated`);
    this.name = 'DeckRunBusyError';
  }
}

export interface StartDeckJobInput extends NativePdfGlossaries {
  /** The run the slides go into, and where its files are stored. */
  run: RunAccess;
  /** The presentation (.pptx, .pptm, .ppsx, .potx or .ppt). */
  file: File;
  /** Display label of the target language. */
  targetLanguage: string;
  /** Slides as a selection (`1-3,7`); the job splits it into batches. */
  pages: string;
  translateNotes: boolean;
  /** The brief of earlier batches of this document, if any. */
  brief?: NativePdfBrief;
  instructions: NativePdfStepInstructions;
  refitRounds: number;
  depth: NativePdfDepth;
  modelId?: string;
  conversationId?: string;
  signal?: AbortSignal;
}

/** A job's state, and the queue it may wait in. */
export interface DeckJobReading {
  job: NativeDeckJobView;
  queue?: NativeDeckQueue;
}

/** Reads `{ success, data }` from a response, or throws what it refused. */
async function dataOf<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw await runErrorFrom(response, fallback);
  const parsed = await response.json().catch(() => null);
  if (!parsed?.success) {
    throw new Error(parsed?.error || `${fallback} (${response.status})`);
  }
  return parsed.data as T;
}

const jobUrl = (run: RunAccess): string =>
  `${JOB_ROUTE}?${new URLSearchParams({ run: run.runId, storage: run.backend })}`;

/**
 * Starts translating a presentation. Answers as soon as the job is stored;
 * follow it with {@link readDeckJob}.
 *
 * @returns The job, and the stored copy of the deck (`sourceId`).
 * @throws DeckRunBusyError while another of the person's presentations is
 *   being translated; RunRequestError for a refused file or options.
 */
export async function startDeckJob(
  input: StartDeckJobInput,
): Promise<DeckJobReading & { sourceId: string; sourceUrl: string }> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('targetLanguage', input.targetLanguage);
  if (input.pages.trim()) form.append('pages', input.pages.trim());
  form.append('translateNotes', String(input.translateNotes));
  form.append('instructions', JSON.stringify(input.instructions));
  form.append('refitRounds', String(input.refitRounds));
  form.append('depth', input.depth);
  form.append('glossaryEntries', JSON.stringify(input.glossaryEntries ?? []));
  form.append('glossaryGuideIds', JSON.stringify(input.glossaryGuideIds ?? []));
  if (input.brief) form.append('brief', JSON.stringify(input.brief));
  if (input.modelId) form.append('modelId', input.modelId);
  if (input.conversationId) form.append('conversationId', input.conversationId);
  form.append('runId', input.run.runId);
  form.append('storage', input.run.backend);
  const response = await fetch(JOB_ROUTE, {
    method: 'POST',
    headers: await runKeyHeaders(input.run),
    body: form,
    signal: input.signal,
  });
  if (response.status === 409) {
    const parsed = await response
      .clone()
      .json()
      .catch(() => null);
    if (parsed?.code === DECK_RUN_ACTIVE) {
      throw new DeckRunBusyError(String(parsed.activeName ?? ''));
    }
  }
  return dataOf(response, 'Could not start the translation');
}

/**
 * Reads a job's progress. A job the server stopped running (a restart) is
 * picked up again by this read.
 *
 * @throws RunMissingError when the run is gone; RunRequestError otherwise.
 */
export async function readDeckJob(
  run: RunAccess,
  signal?: AbortSignal,
): Promise<DeckJobReading> {
  const response = await fetch(jobUrl(run), {
    headers: await runKeyHeaders(run),
    signal,
    cache: 'no-store',
  });
  return dataOf(response, 'Could not read the translation');
}

/**
 * Stops a job. Finished batches are kept; the one in progress is dropped.
 *
 * @returns The job as it is after the request.
 */
export async function stopDeckJob(run: RunAccess): Promise<DeckJobReading> {
  const response = await fetch(jobUrl(run), {
    method: 'DELETE',
    headers: await runKeyHeaders(run),
  });
  return dataOf(response, 'Could not stop the translation');
}

/**
 * Records what each finished batch of a job used against its conversation.
 * Call once per job, when it has ended.
 *
 * @param job - A job that has ended.
 * @param conversationId - The conversation it ran for.
 */
export function recordDeckJobUsage(
  job: NativeDeckJobView,
  conversationId: string | undefined,
): void {
  if (!conversationId) return;
  for (const piece of job.pieces) {
    recordWorkflowUsage(conversationId, piece.usage);
  }
}
