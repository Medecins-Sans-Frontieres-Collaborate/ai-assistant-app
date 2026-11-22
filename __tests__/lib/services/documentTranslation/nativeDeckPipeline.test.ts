import type {
  NativeFormatAdapter,
  RebuildOutcome,
} from '@/lib/services/documentTranslation/native/formats/nativeFormat';
import {
  rerenderNativePdf,
  runNativePdfTranslation,
} from '@/lib/services/documentTranslation/native/nativePdfPipeline';
import { runSandboxScript } from '@/lib/services/documents/sandbox/sandboxScriptRunner';
import { callStructured } from '@/lib/services/workflows/shared/workflowLlm';

import { NATIVE_PDF_FONT_SIZE_STEP } from '@/lib/utils/shared/translation/nativePdf';

import { strToU8 } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pipeline on a presentation (THE FORMAT ADAPTER): the same analyze,
 * translate, check and fix rounds as a PDF, with the deck adapter doing the
 * file work. The adapter and the models are stubbed; what is asserted is
 * what the pipeline asks of the adapter and reports.
 */

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/services/documents/sandbox/sandboxScriptRunner', () => ({
  runSandboxScript: vi.fn(),
}));
vi.mock('@/lib/services/workflows/shared/workflowLlm', () => ({
  callStructured: vi.fn(),
  createAzureClient: vi.fn(() => ({})),
  pngDataUrl: vi.fn(() => 'data:image/png;base64,'),
}));
vi.mock('@/lib/services/workflows/shared/workflowModels', () => ({
  resolveVisionWorkflowModelId: (id: string) => id,
}));
const adapter = vi.hoisted(() => ({
  extract: vi.fn(),
  rebuild: vi.fn(),
}));
vi.mock('@/lib/services/documentTranslation/native/formats/deckFormat', () => ({
  deckFormat: (format: string) =>
    ({ format, ...adapter }) as unknown as NativeFormatAdapter,
}));

const UNITS = [1, 2].map((n) => ({
  id: `d${n}`,
  page: 1,
  n,
  text: `slide text ${n}`,
  tags: {},
  chars: 12,
  size: 24,
  lines: 1,
  roomFactor: 1.2,
  bbox: [10, 10 * n, 110, 10 * n + 8],
  room: [10, 10 * n, 160, 10 * n + 12],
  deck: { kind: 'slide', part: 'ppt/slides/slide1.xml', path: [n], copies: [] },
}));
const UNITS_FILE = strToU8(
  JSON.stringify({
    pageCount: 3,
    pages: [
      {
        page: 1,
        width: 720,
        height: 540,
        units: 2,
        textChars: 24,
        scanned: false,
      },
    ],
    units: UNITS,
  }),
);

const built = (overrides: Partial<RebuildOutcome> = {}): RebuildOutcome => ({
  fits: UNITS.map((unit) => ({
    id: unit.id,
    page: 1,
    n: unit.n,
    scale: 1,
    fits: true,
    used: unit.room as [number, number, number, number],
  })),
  fonts: { sans: 'Calibri', serif: 'Cambria' },
  pdf: strToU8('%PDF-deck'),
  exports: {},
  document: strToU8('PK-deck'),
  outputs: [{ page: 1, preview: strToU8('p'), check: strToU8('c') }],
  ...overrides,
});

function stubModels(checks: unknown[][]) {
  let checked = 0;
  vi.mocked(callStructured).mockImplementation((async (call: {
    usageLabel: string;
  }) => {
    switch (call.usageLabel) {
      case 'native-pdf-analyze':
        return {
          pageNotes: '',
          units: UNITS.map((unit) => ({
            n: unit.n,
            role: 'body',
            translate: true,
            note: '',
          })),
        };
      case 'native-pdf-language':
        return { code: 'fr', note: '' };
      case 'native-pdf-terms':
        return { terms: [] };
      case 'native-pdf-translate':
        return {
          units: UNITS.map((unit) => ({
            id: unit.id,
            text: `texte ${unit.n}`,
          })),
        };
      case 'native-pdf-verify': {
        const issues = checks[Math.min(checked, checks.length - 1)];
        checked += 1;
        return { issues };
      }
      default:
        return { units: [], issues: [], terms: [] };
    }
  }) as never);
}

const run = (maxRefitRounds = 1) =>
  runNativePdfTranslation({
    document: Buffer.from('PK'),
    format: 'pptm',
    translateNotes: false,
    targetLanguage: 'French',
    pages: [1],
    instructions: {},
    modelId: 'model',
    maxRefitRounds,
    depth: 'quick',
    glossaryEntries: [],
    usage: { recordRaw: vi.fn(), record: vi.fn() } as never,
  });

beforeEach(() => {
  vi.mocked(callStructured).mockReset();
  adapter.extract.mockReset();
  adapter.rebuild.mockReset();
  adapter.extract.mockResolvedValue({
    unitsFile: UNITS_FILE,
    pageImage: () => strToU8('labelled'),
  });
  adapter.rebuild.mockResolvedValue(built());
});

describe('a presentation through the pipeline', () => {
  it('uses the deck adapter, never the PDF script, and returns the deck', async () => {
    stubModels([[]]);
    const result = await run();
    expect(runSandboxScript).not.toHaveBeenCalled();
    expect(adapter.extract).toHaveBeenCalledWith(
      expect.anything(),
      [1],
      expect.objectContaining({ translateNotes: false }),
    );
    expect(result.document).toEqual(strToU8('PK-deck'));
    expect(result.units.map((unit) => unit.translation)).toEqual([
      'texte 1',
      'texte 2',
    ]);
  });

  it('checks the rendered slides and applies the fixes in a rebuild of the deck', async () => {
    stubModels([
      [
        {
          n: 1,
          kind: 'overflow',
          severity: 'major',
          note: 'runs over',
          fix: { action: 'smaller', percent: 90, dx: 0, dy: 0 },
        },
      ],
      [],
    ]);
    const result = await run(1);
    expect(adapter.rebuild).toHaveBeenCalledTimes(2);
    const [, , , output] = adapter.rebuild.mock.calls[1];
    // 90% of 24, rounded down to a size a person could set by hand.
    const expected =
      Math.floor((24 * 0.9) / NATIVE_PDF_FONT_SIZE_STEP) *
      NATIVE_PDF_FONT_SIZE_STEP;
    expect(output.styles.d1.size).toBeCloseTo(expected, 5);
    expect(result.styles.d1.size).toBeCloseTo(expected, 5);
    expect(result.issues).toEqual([]);
  });

  it('delivers the deck unchecked when its slides could not be rendered', async () => {
    stubModels([[]]);
    adapter.rebuild.mockResolvedValue(
      built({ pdf: null, outputs: [], unpictured: [1] }),
    );
    const result = await run(0);
    expect(result.pdf).toBeNull();
    expect(result.document).toEqual(strToU8('PK-deck'));
    expect(result.uncheckedPages).toEqual([1]);
    // Nothing to look at: the check was never asked.
    expect(
      vi
        .mocked(callStructured)
        .mock.calls.some(([call]) => call.usageLabel === 'native-pdf-verify'),
    ).toBe(false);
  });

  it('reads slides that could not be pictured from their text alone', async () => {
    stubModels([[]]);
    adapter.extract.mockResolvedValue({
      unitsFile: UNITS_FILE,
      pageImage: () => null,
    });
    const result = await run(0);
    const analyze = vi
      .mocked(callStructured)
      .mock.calls.find(([call]) => call.usageLabel === 'native-pdf-analyze')!;
    const content = analyze[0].user as Array<{ type: string }>;
    expect(content.map((part) => part.type)).toEqual(['text']);
    expect(result.units.map((unit) => unit.translation)).toEqual([
      'texte 1',
      'texte 2',
    ]);
  });

  it('reports a unit whose part could not be written as not translated', async () => {
    stubModels([[]]);
    const fits = built().fits.map((fit) =>
      fit.id === 'd2' ? { ...fit, kept: true } : fit,
    );
    adapter.rebuild.mockResolvedValue(built({ fits }));
    const result = await run(0);
    expect(
      result.units.find((unit) => unit.id === 'd2')?.translation,
    ).toBeNull();
    expect(
      result.steps.find((step) => step.id === 'rebuild')?.detail,
    ).toContain('1 could not be written');
  });

  it('re-renders from the original deck with the edits, the source format passed on', async () => {
    adapter.rebuild.mockResolvedValue(built());
    const result = await rerenderNativePdf({
      document: Buffer.from('PK-original'),
      format: 'pptx',
      unitsFiles: [UNITS_FILE],
      translations: { d1: 'modifié' },
      checkPages: [],
      imagePages: [1],
      maxDocumentPages: 10,
      instructions: {},
      modelId: 'model',
      usage: {} as never,
    });
    const [document, , translations, output] = adapter.rebuild.mock.calls[0];
    expect(document.toString()).toBe('PK-original');
    expect(translations.get('d1')).toBe('modifié');
    expect(output.imagePages).toEqual([1]);
    expect(result.document).toEqual(strToU8('PK-deck'));
  });
});
