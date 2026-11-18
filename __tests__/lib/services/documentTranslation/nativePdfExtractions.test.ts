import {
  NativePdfDocumentLimitError,
  NativePdfNoPagesLeftError,
  combineExtractions,
  rerenderNativePdf,
} from '@/lib/services/documentTranslation/native/nativePdfPipeline';
import { runSandboxScript } from '@/lib/services/documentTranslation/native/sandboxScriptRunner';

import { strFromU8, strToU8 } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock(
  '@/lib/services/documentTranslation/native/sandboxScriptRunner',
  () => ({ runSandboxScript: vi.fn() }),
);

const unit = (page: number, n: number, text = `text ${page}.${n}`) => ({
  id: `p${page}-b0-${n}`,
  page,
  n,
  text,
  tags: {},
  chars: text.length,
  bbox: [0, 0, 10, 10],
  room: [0, 0, 20, 20],
});
const stats = (page: number, units: number) => ({
  page,
  width: 500,
  height: 700,
  units,
  textChars: 100,
  scanned: false,
});
const extraction = (pages: Record<number, number>, pageCount = 9) =>
  strToU8(
    JSON.stringify({
      pageCount,
      pages: Object.entries(pages).map(([page, count]) =>
        stats(Number(page), count),
      ),
      units: Object.entries(pages).flatMap(([page, count]) =>
        Array.from({ length: count }, (_, index) =>
          unit(Number(page), index + 1),
        ),
      ),
    }),
  );
const read = (bytes: Uint8Array) =>
  JSON.parse(strFromU8(bytes)) as {
    pageCount: number;
    pages: { page: number; units: number }[];
    units: { id: string; page: number; text: string }[];
  };

describe('combineExtractions', () => {
  it('returns a single extraction untouched', () => {
    const only = extraction({ 1: 2 });
    expect(combineExtractions([only])).toBe(only);
  });

  it('joins batches into one extraction in page order', () => {
    const joined = read(
      combineExtractions([extraction({ 4: 1, 5: 2 }), extraction({ 1: 2 })]),
    );
    expect(joined.pageCount).toBe(9);
    expect(joined.pages.map((page) => page.page)).toEqual([1, 4, 5]);
    expect(joined.units.map((u) => u.id)).toEqual([
      'p1-b0-1',
      'p1-b0-2',
      'p4-b0-1',
      'p5-b0-1',
      'p5-b0-2',
    ]);
  });

  it('takes a page held twice from the later extraction only', () => {
    const later = strToU8(
      JSON.stringify({
        pageCount: 9,
        pages: [stats(2, 1)],
        units: [unit(2, 1, 'newer')],
      }),
    );
    const joined = read(
      combineExtractions([extraction({ 2: 3, 3: 1 }), later]),
    );
    // Page 2 had three units; the later extraction's single one replaces
    // all of them rather than mixing with them.
    expect(joined.units.filter((u) => u.page === 2)).toEqual([
      expect.objectContaining({ text: 'newer' }),
    ]);
    expect(joined.pages.find((page) => page.page === 2)?.units).toBe(1);
    expect(joined.units.filter((u) => u.page === 3)).toHaveLength(1);
  });

  it('refuses a file that is not an extraction', () => {
    expect(() =>
      combineExtractions([extraction({ 1: 1 }), strToU8('not json')]),
    ).toThrow(/unreadable/);
    expect(() =>
      combineExtractions([extraction({ 1: 1 }), strToU8('{"units":3}')]),
    ).toThrow(/unreadable/);
  });
});

describe('rerenderNativePdf: document page limit', () => {
  const translations = (pages: number[]) =>
    Object.fromEntries(pages.map((page) => [`p${page}-b0-1`, 'traduit']));
  const params = (pages: number[], maxDocumentPages: number) => ({
    document: Buffer.from('%PDF-1.4'),
    unitsFiles: [extraction({ 1: 1, 2: 1, 3: 1 })],
    translations: translations(pages),
    checkPages: [],
    imagePages: [],
    maxDocumentPages,
    instructions: {},
    modelId: 'model',
    usage: {} as never,
  });

  beforeEach(() => {
    vi.mocked(runSandboxScript).mockReset();
    vi.mocked(runSandboxScript).mockResolvedValue({
      files: new Map([
        [
          'report.json',
          strToU8(
            JSON.stringify({ fonts: { sans: 'A', serif: 'B' }, units: [] }),
          ),
        ],
        ['translated.pdf', strToU8('%PDF-out')],
      ]),
    } as never);
  });

  it('lays out a document at its limit', async () => {
    const result = await rerenderNativePdf(params([1, 2], 2));
    expect(strFromU8(result.pdf)).toBe('%PDF-out');
    // The whole document is returned, and no page images were asked for.
    const job = JSON.parse(
      vi
        .mocked(runSandboxScript)
        .mock.calls[0][1].find((file) => file.filename === 'job.json')
        ?.data.toString() ?? '{}',
    );
    expect(job).toMatchObject({ onlyTranslatedPages: false, imagePages: [] });
  });

  it('refuses one page more, before any sandbox work', async () => {
    await expect(rerenderNativePdf(params([1, 2, 3], 2))).rejects.toThrow(
      NativePdfDocumentLimitError,
    );
    expect(runSandboxScript).not.toHaveBeenCalled();
  });
});

describe('rerenderNativePdf: pages left out of the result', () => {
  // A 3-page document with a translation on page 1.
  const params = (omitPages: number[] | undefined) => ({
    document: Buffer.from('%PDF-1.4'),
    unitsFiles: [extraction({ 1: 1 }, 3)],
    translations: { 'p1-b0-1': 'traduit' },
    checkPages: [],
    imagePages: [],
    omitPages,
    maxDocumentPages: 5,
    instructions: {},
    modelId: 'model',
    usage: {} as never,
  });
  const job = () =>
    JSON.parse(
      vi
        .mocked(runSandboxScript)
        .mock.calls[0][1].find((file) => file.filename === 'job.json')
        ?.data.toString() ?? '{}',
    );

  beforeEach(() => {
    vi.mocked(runSandboxScript).mockReset();
    vi.mocked(runSandboxScript).mockResolvedValue({
      files: new Map([
        [
          'report.json',
          strToU8(
            JSON.stringify({ fonts: { sans: 'A', serif: 'B' }, units: [] }),
          ),
        ],
        ['translated.pdf', strToU8('%PDF-out')],
      ]),
    } as never);
  });

  it('asks for nothing to be left out by default', async () => {
    await rerenderNativePdf(params(undefined));
    expect(job()).not.toHaveProperty('omitPages');
  });

  it('passes the pages on, once each, and only pages the document has', async () => {
    await rerenderNativePdf(params([2, 2, 7]));
    expect(job().omitPages).toEqual([2]);
  });

  it('leaves out all pages but one, and refuses to leave out every page', async () => {
    await rerenderNativePdf(params([1, 2]));
    expect(job().omitPages).toEqual([1, 2]);
    vi.mocked(runSandboxScript).mockClear();
    await expect(rerenderNativePdf(params([1, 2, 3]))).rejects.toThrow(
      NativePdfNoPagesLeftError,
    );
    expect(runSandboxScript).not.toHaveBeenCalled();
  });
});
