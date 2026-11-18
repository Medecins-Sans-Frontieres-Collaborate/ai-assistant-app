'use client';

import { recordWorkflowUsage } from '@/client/services/workflows/workflowUsageRecorder';

import {
  NativePdfDepth,
  NativePdfRenderReport,
  NativePdfRunReport,
  NativePdfStepId,
  NativePdfStepInstructions,
  NativePdfStepRecord,
  NativePdfStreamEvent,
  NativePdfUnitAction,
} from '@/lib/utils/shared/translation/nativePdf';

import { GlossaryEntry } from '@/types/workflow';

const BASE = '/api/document-translation/native';

interface UsagePayload {
  totalTokens?: number;
}

/** Glossaries sent with a request; organization ones resolve server-side. */
export interface NativePdfGlossaries {
  glossaryEntries?: GlossaryEntry[];
  glossaryGuideIds?: string[];
}

export interface NativePdfAvailability {
  enabled: boolean;
  maxPages: number;
  maxRefitRounds: number;
}

/**
 * Asks whether formatting-preserving PDF translation is available.
 *
 * @returns The server's answer; `enabled: false` when it cannot be reached,
 *   so the option simply is not offered.
 */
export async function fetchNativePdfAvailability(
  signal?: AbortSignal,
): Promise<NativePdfAvailability> {
  const off = { enabled: false, maxPages: 0, maxRefitRounds: 0 };
  try {
    const response = await fetch(BASE, { signal });
    const parsed = await response.json().catch(() => null);
    return response.ok && parsed?.success
      ? (parsed.data as NativePdfAvailability)
      : off;
  } catch {
    return off;
  }
}

export interface NativePdfRunInput extends NativePdfGlossaries {
  file: File;
  /** Display label of the target language. */
  targetLanguage: string;
  pages: string;
  instructions: NativePdfStepInstructions;
  refitRounds: number;
  depth: NativePdfDepth;
  modelId?: string;
  conversationId?: string;
  signal?: AbortSignal;
  /** A step started (`active`) or ended (its record). */
  onStep: (
    step: { id: NativePdfStepId; status: 'active' } | NativePdfStepRecord,
  ) => void;
}

/**
 * Runs a formatting-preserving translation and reports each step as it
 * happens.
 *
 * @returns The finished run and the tokens it used.
 * @throws Error with a readable message when the request is refused or the
 *   run fails; an `AbortError` when `signal` stops it.
 */
export async function runNativePdf(
  input: NativePdfRunInput,
): Promise<{ report: NativePdfRunReport; totalTokens: number }> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('targetLanguage', input.targetLanguage);
  if (input.pages.trim()) form.append('pages', input.pages.trim());
  form.append('instructions', JSON.stringify(input.instructions));
  form.append('refitRounds', String(input.refitRounds));
  form.append('depth', input.depth);
  form.append('glossaryEntries', JSON.stringify(input.glossaryEntries ?? []));
  form.append('glossaryGuideIds', JSON.stringify(input.glossaryGuideIds ?? []));
  if (input.modelId) form.append('modelId', input.modelId);
  if (input.conversationId) form.append('conversationId', input.conversationId);

  const response = await fetch(BASE, {
    method: 'POST',
    body: form,
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    const parsed = await response.json().catch(() => null);
    throw new Error(parsed?.error || `Translation failed (${response.status})`);
  }

  // Newline-delimited JSON: a line may arrive split across chunks.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: (NativePdfRunReport & { usage?: UsagePayload }) | null = null;
  const handle = (line: string): void => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as NativePdfStreamEvent;
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'result') result = event.data;
    else {
      const { type: _type, ...step } = event;
      input.onStep(step);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handle(line);
    if (done) break;
  }
  handle(buffer);
  const finished = result as
    | (NativePdfRunReport & { usage?: UsagePayload })
    | null;
  if (!finished) throw new Error('The translation ended without a result');
  if (input.conversationId) {
    recordWorkflowUsage(input.conversationId, finished.usage);
  }
  return { report: finished, totalTokens: finished.usage?.totalTokens ?? 0 };
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  fallback: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.success) {
    throw new Error(parsed?.error || `${fallback} (${response.status})`);
  }
  if (typeof body.conversationId === 'string') {
    recordWorkflowUsage(body.conversationId, parsed.data?.usage);
  }
  return parsed.data as T;
}

export interface NativePdfRenderInput {
  sourceId: string;
  unitsId: string;
  /** Every unit that should be translated, by id. */
  translations: Record<string, string>;
  /** Pages to run the layout check on afterwards. */
  checkPages: number[];
  instructions: NativePdfStepInstructions;
  modelId?: string;
  conversationId?: string;
  signal?: AbortSignal;
}

/**
 * Lays a run's pages out again with edited translations.
 *
 * @throws Error with a readable message when the server refuses or fails.
 */
export function renderNativePdf(
  input: NativePdfRenderInput,
): Promise<NativePdfRenderReport> {
  const { signal, ...body } = input;
  return postJson('render', body, 'Re-rendering failed', signal);
}

export interface NativePdfUnitInput extends NativePdfGlossaries {
  action: NativePdfUnitAction;
  targetLanguage: string;
  source: string;
  translation: string;
  instruction?: string;
  targetChars: number;
  modelId?: string;
  conversationId?: string;
  signal?: AbortSignal;
}

/**
 * Asks for a new wording of one block: shorter, changed as described, or a
 * first translation of a block that was kept as written.
 *
 * @returns The new text with its inline tags.
 * @throws Error with a readable message when the server refuses or fails.
 */
export function reviseNativePdfUnit(
  input: NativePdfUnitInput,
): Promise<{ text: string; repaired: boolean }> {
  const { signal, ...body } = input;
  return postJson('unit', body, 'Changing the block failed', signal);
}

/**
 * Loads a stored page image. The file route answers images as JSON holding
 * a data URL, not as image bytes, so an `<img src>` cannot point at it.
 *
 * @param url - A `previewUrl` or `checkUrl` of a run.
 * @returns A data URL to use as an image source.
 * @throws Error when the image cannot be read (for example it expired).
 */
export async function fetchNativePdfImage(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(url, { signal });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || typeof parsed?.base64Url !== 'string') {
    throw new Error(`The page image could not be loaded (${response.status})`);
  }
  return parsed.base64Url as string;
}
