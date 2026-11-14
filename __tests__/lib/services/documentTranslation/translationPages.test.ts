import { TranslationJob } from '@/lib/services/documentTranslation/translationJobStore';
import {
  InvalidCorrectionError,
  MAX_PAGE_CORRECTION_CHARS,
  PagedTextUnsupportedError,
  TranslationFilesMissingError,
  correctedPageNumbers,
  effectiveTranslation,
  getPageCorrections,
  getTranslationPages,
  savePageCorrection,
} from '@/lib/services/documentTranslation/translationPages';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExtract = vi.hoisted(() => vi.fn());
vi.mock('@/lib/utils/server/file/fileHandling', () => ({
  extractPdfPageTexts: mockExtract,
  removeTempDir: vi.fn(),
}));

const JOB: TranslationJob = {
  jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  userId: 'user-1',
  operationId: 'op',
  filename: 'guide.pdf',
  translatedFilename: 'guide_es.pdf',
  ext: 'pdf',
  targetLanguage: 'es',
  createdAt: 0,
};
const PREFIX = `${JOB.userId}/translations/${JOB.jobId}`;
const ORIGINAL = `${PREFIX}_original.pdf`;
const TRANSLATED = `${PREFIX}.pdf`;
const PAGES = `${PREFIX}_pages.json`;
const CORRECTIONS = `${PREFIX}_corrections.json`;

/** In-memory stand-in for the user's blob container. */
function createStorage(initial: Record<string, string>) {
  const blobs = new Map(Object.entries(initial));
  const storage = {
    blobExists: vi.fn(async (name: string) => blobs.has(name)),
    get: vi.fn(async (name: string) => Buffer.from(blobs.get(name)!)),
    upload: vi.fn(async (name: string, content: string | Buffer) => {
      blobs.set(name, content.toString());
      return name;
    }),
  };
  return { storage: storage as unknown as BlobStorage, blobs, spies: storage };
}

/** Extractor stub: page texts depend on which file is read. */
function stubExtraction(source: string[], translated: string[]) {
  mockExtract.mockImplementation(async (filePath: string) =>
    filePath.includes('source.') ? source : translated,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getTranslationPages', () => {
  it('pairs source and translated pages by page number and caches the result', async () => {
    const { storage, blobs } = createStorage({
      [ORIGINAL]: 'pdf',
      [TRANSLATED]: 'pdf',
    });
    stubExtraction(['one', 'two'], ['uno', 'dos']);

    const record = await getTranslationPages(storage, JOB);

    expect(record.pageCount).toBe(2);
    expect(record.pagesAligned).toBe(true);
    expect(record.pages).toEqual([
      { page: 1, source: 'one', translation: 'uno' },
      { page: 2, source: 'two', translation: 'dos' },
    ]);
    expect(JSON.parse(blobs.get(PAGES)!)).toEqual(record);
  });

  it('serves the cache without extracting again', async () => {
    const { storage } = createStorage({
      [ORIGINAL]: 'pdf',
      [TRANSLATED]: 'pdf',
    });
    stubExtraction(['one'], ['uno']);
    await getTranslationPages(storage, JOB);
    mockExtract.mockClear();

    const again = await getTranslationPages(storage, JOB);

    expect(again.pages[0].translation).toBe('uno');
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('flags a page-count mismatch and pads the shorter side', async () => {
    const { storage } = createStorage({
      [ORIGINAL]: 'pdf',
      [TRANSLATED]: 'pdf',
    });
    stubExtraction(['one', 'two'], ['uno', 'dos', 'tres']);

    const record = await getTranslationPages(storage, JOB);

    expect(record.pagesAligned).toBe(false);
    expect(record.pageCount).toBe(3);
    expect(record.pages[2]).toEqual({
      page: 3,
      source: '',
      translation: 'tres',
    });
  });

  it('rebuilds a corrupt cache instead of failing', async () => {
    const { storage } = createStorage({
      [ORIGINAL]: 'pdf',
      [TRANSLATED]: 'pdf',
      [PAGES]: '{"version":1,"pages":[',
    });
    stubExtraction(['one'], ['uno']);

    const record = await getTranslationPages(storage, JOB);

    expect(record.pages).toHaveLength(1);
    expect(mockExtract).toHaveBeenCalledTimes(2);
  });

  it('refuses formats without a page view', async () => {
    const { storage } = createStorage({});
    await expect(
      getTranslationPages(storage, { ...JOB, ext: 'docx' }),
    ).rejects.toBeInstanceOf(PagedTextUnsupportedError);
  });

  it('reports which file is missing', async () => {
    const noTranslation = createStorage({ [ORIGINAL]: 'pdf' });
    await expect(
      getTranslationPages(noTranslation.storage, JOB),
    ).rejects.toThrow(/translated file/);

    const noOriginal = createStorage({ [TRANSLATED]: 'pdf' });
    await expect(
      getTranslationPages(noOriginal.storage, JOB),
    ).rejects.toBeInstanceOf(TranslationFilesMissingError);
  });
});

describe('page corrections', () => {
  const PAGE_COUNT = 3;

  it('saves, overwrites and removes a correction', async () => {
    const { storage } = createStorage({});

    await savePageCorrection(storage, JOB, 2, '1 comp.', PAGE_COUNT);
    await savePageCorrection(storage, JOB, 3, 'tres', PAGE_COUNT);
    let corrections = await getPageCorrections(storage, JOB);
    expect(corrections.get(2)?.text).toBe('1 comp.');
    expect(correctedPageNumbers(corrections)).toEqual([2, 3]);

    await savePageCorrection(storage, JOB, 2, '1 comprimido', PAGE_COUNT);
    await savePageCorrection(storage, JOB, 3, null, PAGE_COUNT);
    corrections = await getPageCorrections(storage, JOB);
    expect(corrections.get(2)?.text).toBe('1 comprimido');
    expect(corrections.has(3)).toBe(false);
  });

  it('keeps an empty string as a correction (the page is intentionally blank)', async () => {
    const { storage } = createStorage({});
    const corrections = await savePageCorrection(
      storage,
      JOB,
      1,
      '',
      PAGE_COUNT,
    );
    expect(corrections.get(1)?.text).toBe('');
  });

  it('accepts the first and last page and refuses the pages just outside', async () => {
    const { storage } = createStorage({});
    await expect(
      savePageCorrection(storage, JOB, 1, 'a', PAGE_COUNT),
    ).resolves.toBeDefined();
    await expect(
      savePageCorrection(storage, JOB, PAGE_COUNT, 'a', PAGE_COUNT),
    ).resolves.toBeDefined();
    for (const page of [0, PAGE_COUNT + 1, 1.5]) {
      await expect(
        savePageCorrection(storage, JOB, page, 'a', PAGE_COUNT),
      ).rejects.toBeInstanceOf(InvalidCorrectionError);
    }
  });

  it('accepts text at the length limit and refuses one character more', async () => {
    const { storage, spies } = createStorage({});
    await expect(
      savePageCorrection(
        storage,
        JOB,
        1,
        'x'.repeat(MAX_PAGE_CORRECTION_CHARS),
        PAGE_COUNT,
      ),
    ).resolves.toBeDefined();
    spies.upload.mockClear();
    await expect(
      savePageCorrection(
        storage,
        JOB,
        1,
        'x'.repeat(MAX_PAGE_CORRECTION_CHARS + 1),
        PAGE_COUNT,
      ),
    ).rejects.toBeInstanceOf(InvalidCorrectionError);
    expect(spies.upload).not.toHaveBeenCalled();
  });

  it('reads no corrections from a missing or corrupt record', async () => {
    expect(await getPageCorrections(createStorage({}).storage, JOB)).toEqual(
      new Map(),
    );
    expect(
      await getPageCorrections(
        createStorage({ [CORRECTIONS]: 'not json' }).storage,
        JOB,
      ),
    ).toEqual(new Map());
  });
});

describe('corrections as stored', () => {
  const stored = (corrections: Record<string, unknown>) =>
    createStorage({
      [CORRECTIONS]: JSON.stringify({ version: 1, corrections }),
    }).storage;
  const fix = { text: 'x', updatedAt: 'then' };

  it('reads back only whole page numbers from 1 up', async () => {
    const corrections = await getPageCorrections(
      stored({ '1': fix, '0': fix, '-2': fix, '2.5': fix, abc: fix, '7': fix }),
      JOB,
    );
    expect(correctedPageNumbers(corrections)).toEqual([1, 7]);
  });

  it('cannot be steered onto the object prototype by a stored key', async () => {
    // JSON.parse keeps "__proto__" as an own key; it must not be applied.
    const storage = createStorage({
      [CORRECTIONS]:
        '{"version":1,"corrections":{"__proto__":{"text":"evil","updatedAt":"t"},"constructor":{"text":"evil","updatedAt":"t"},"3":{"text":"ok","updatedAt":"t"}}}',
    }).storage;
    const corrections = await getPageCorrections(storage, JOB);
    expect(correctedPageNumbers(corrections)).toEqual([3]);
    expect(({} as Record<string, unknown>).text).toBeUndefined();
  });

  it('lists corrected pages in numeric, not text, order', async () => {
    const corrections = await getPageCorrections(
      stored({ '10': fix, '9': fix, '100': fix }),
      JOB,
    );
    expect(correctedPageNumbers(corrections)).toEqual([9, 10, 100]);
  });

  it('writes a record the reader accepts', async () => {
    const { storage, spies } = createStorage({});
    await savePageCorrection(storage, JOB, 2, 'dos', 3);
    const written = JSON.parse(spies.upload.mock.calls.at(-1)![1] as string);
    expect(written.version).toBe(1);
    expect(Object.keys(written.corrections)).toEqual(['2']);
    expect(written.corrections['2'].text).toBe('dos');
  });
});

describe('effectiveTranslation', () => {
  const page = { page: 4, source: 'tab', translation: 'pestaña' };

  it('prefers the correction, including an empty one', () => {
    const at = '2026-01-01T00:00:00.000Z';
    expect(
      effectiveTranslation(
        page,
        new Map([[4, { text: 'comp.', updatedAt: at }]]),
      ),
    ).toBe('comp.');
    expect(
      effectiveTranslation(page, new Map([[4, { text: '', updatedAt: at }]])),
    ).toBe('');
  });

  it('falls back to the machine translation', () => {
    expect(effectiveTranslation(page, new Map())).toBe('pestaña');
  });
});
