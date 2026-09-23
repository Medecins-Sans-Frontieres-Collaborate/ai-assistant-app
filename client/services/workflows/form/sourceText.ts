'use client';

import { fetchUrlContent } from '@/client/services/url/urlFetchClient';

import { markdownToProse } from '@/lib/utils/shared/markdown/markdownToProse';

import { FillNote, FillSourceRecord } from '@/types/formFill';

/**
 * Source text lives OUTSIDE workflow state (only metadata persists, the
 * DocumentReference rule). This module holds the texts in memory for the
 * session and re-fetches on demand after a reload: files through the
 * process route's text cache, pages through the fetch-url route, notes
 * from state itself.
 */

const cache = new Map<string, string>();

export function rememberSourceText(sourceId: string, text: string): void {
  cache.set(sourceId, text);
}

/**
 * A fetched PAGE arrives as Markdown. What the workflows verify, show and
 * quote must be the page's prose, so it is converted once, here, and every
 * reader of the cache sees the same text. Returns the prose.
 */
export function rememberPageText(sourceId: string, markdown: string): string {
  const prose = markdownToProse(markdown);
  cache.set(sourceId, prose);
  return prose;
}

export function forgetSourceText(sourceId: string): void {
  cache.delete(sourceId);
}

async function refetchFile(fileId: string): Promise<string> {
  const response = await fetch('/api/file/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: fileId }),
  });
  if (!response.ok)
    throw new Error(`Could not re-read the file (${response.status})`);
  const data = (await response.json()) as {
    results?: Array<{ content?: string }>;
  };
  return data.results?.[0]?.content ?? '';
}

/**
 * Text for one source. Returns '' (never throws) when the material cannot
 * be retrieved, so a fill run proceeds with what it has; the caller lists
 * unavailable sources to the user.
 */
export async function getSourceText(
  source: FillSourceRecord,
  notes: FillNote[],
): Promise<string> {
  const cached = cache.get(source.id);
  if (cached !== undefined) return cached;
  let text = '';
  try {
    if (source.kind === 'note') {
      text = notes.find((n) => n.sourceId === source.id)?.text ?? '';
    } else if (source.text) {
      // search / M365 mail: kept inline in state (no re-fetch path).
      text = source.text;
    } else if (
      (source.kind === 'file' || source.kind === 'm365') &&
      source.fileId
    ) {
      text = await refetchFile(source.fileId);
    } else if (source.kind === 'url' && source.url) {
      const result = await fetchUrlContent(source.url);
      text = result.ok ? markdownToProse(result.page.text) : '';
    }
  } catch {
    text = '';
  }
  if (text) cache.set(source.id, text);
  return text;
}

export async function collectSourceTexts(
  sources: FillSourceRecord[],
  notes: FillNote[],
): Promise<{
  available: Array<{ record: FillSourceRecord; text: string }>;
  unavailable: FillSourceRecord[];
}> {
  const available: Array<{ record: FillSourceRecord; text: string }> = [];
  const unavailable: FillSourceRecord[] = [];
  for (const record of sources) {
    if (record.kind === 'note') continue; // sent separately as notes
    const text = await getSourceText(record, notes);
    if (text.trim()) available.push({ record, text });
    else unavailable.push(record);
  }
  return { available, unavailable };
}
