import { mergeTranslatedDeck } from '@/lib/services/documentTranslation/deck/deckMerge';
import { TranslationJob } from '@/lib/services/documentTranslation/translationJobStore';
import { getTranslationPages } from '@/lib/services/documentTranslation/translationPages';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The reader's slide-by-slide text of a translated presentation: slide n
 * on both sides is the presentation's slide n, hidden slides included,
 * with each slide's speaker notes.
 */

const FIXTURES = path.join(__dirname, '../../../../fixtures/pptx');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

const job = (ext: string): TranslationJob => ({
  jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  userId: 'user-1',
  operationId: 'op',
  filename: `deck.${ext}`,
  translatedFilename: `deck_fr.${ext}`,
  ext,
  targetLanguage: 'fr',
  createdAt: 0,
  serviceExt: 'pptx',
  translateNotes: true,
});

/** In-memory user storage that keeps blobs as bytes. */
function storageWith(blobs: Record<string, Buffer>): BlobStorage {
  const store = new Map(Object.entries(blobs));
  return {
    blobExists: vi.fn(async (name: string) => store.has(name)),
    get: vi.fn(async (name: string) => store.get(name)!),
    upload: vi.fn(async (name: string, content: string | Buffer) => {
      store.set(name, Buffer.from(content));
      return name;
    }),
  } as unknown as BlobStorage;
}

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pages-test-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The deck the person gets: their package with the translation in it. */
async function delivered(base: string, translateNotes: boolean) {
  const out = path.join(dir, `delivered-${translateNotes}-${base}`);
  await mergeTranslatedDeck({
    basePath: path.join(FIXTURES, base),
    translatedPath: path.join(FIXTURES, 'rich.fr.pptx'),
    outPath: out,
    translateNotes,
  });
  return fs.readFileSync(out);
}

describe('slides in the reader', () => {
  it('pairs slides by number, marks hidden ones and carries the notes', async () => {
    const deckJob = job('pptx');
    const prefix = `user-1/translations/${deckJob.jobId}`;
    const storage = storageWith({
      [`${prefix}_original.pptx`]: fixture('rich.pptx'),
      [`${prefix}.pptx`]: await delivered('rich.pptx', true),
    });

    const record = await getTranslationPages(storage, deckJob);

    expect(record.pageCount).toBe(5);
    expect(record.pagesAligned).toBe(true);
    expect(record.pages[0]).toEqual({
      page: 1,
      source: 'Annual report\nThe clinic opened in March.',
      translation: 'Rapport annuel\nLa clinique a ouvert en mars.',
      sourceNotes: 'Remember to thank the volunteers.',
      translationNotes: "N'oubliez pas de remercier les bénévoles.",
    });
    expect(record.pages.map((page) => page.hidden ?? false)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
    // A slide without notes has no notes fields at all.
    expect(record.pages[1]).not.toHaveProperty('sourceNotes');
  });

  it('shows kept notes as the same text on both sides', async () => {
    const deckJob = job('pptm');
    const prefix = `user-1/translations/${deckJob.jobId}`;
    const storage = storageWith({
      [`${prefix}_original.pptm`]: fixture('rich.pptm'),
      [`${prefix}.pptm`]: await delivered('rich.pptm', false),
    });

    const record = await getTranslationPages(storage, deckJob);

    expect(record.pages[0].translation).toContain('Rapport annuel');
    expect(record.pages[0].translationNotes).toBe(record.pages[0].sourceNotes);
  });
});
