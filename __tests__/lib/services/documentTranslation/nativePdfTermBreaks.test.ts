import { runNativePdfTranslation } from '@/lib/services/documentTranslation/native/nativePdfPipeline';
import { runSandboxScript } from '@/lib/services/documentTranslation/native/sandboxScriptRunner';
import { callStructured } from '@/lib/services/workflows/shared/workflowLlm';

import { strToU8 } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock(
  '@/lib/services/documentTranslation/native/sandboxScriptRunner',
  () => ({ runSandboxScript: vi.fn() }),
);
vi.mock('@/lib/services/workflows/shared/workflowLlm', () => ({
  callStructured: vi.fn(),
  createAzureClient: vi.fn(() => ({})),
  pngDataUrl: vi.fn(() => 'data:image/png;base64,'),
}));
vi.mock('@/lib/services/workflows/shared/workflowModels', () => ({
  resolveVisionWorkflowModelId: (id: string) => id,
}));

/**
 * A unit that is one of the brief's terms takes the brief's wording on
 * every page. Terms are matched with their line breaks read as spaces, so
 * the wording has none: the unit's own breaks must come back (BREAKS in the
 * layout script), or a header the author set on two lines is set on one.
 */

const HEADER = {
  id: 'p1-b0-1',
  page: 1,
  n: 1,
  text: 'TIME/\nAPPROVED',
  tags: {},
  chars: 14,
  size: 16,
  color: '#000000',
  lines: 2,
  roomFactor: 1.2,
  bbox: [10, 10, 60, 40],
  room: [10, 10, 70, 44],
};
const BRIEF = {
  language: { code: 'fr', name: 'French', note: '' },
  terms: [{ source: 'Time/ Approved', target: 'Durée/approuvée', keep: false }],
};

/** What the first rebuild was asked to set for the header. */
const laidOut = () => {
  const [, files] = vi
    .mocked(runSandboxScript)
    .mock.calls.find(([command]) => command === 'rebuild')!;
  const job = JSON.parse(
    files.find((file) => file.filename === 'job.json')!.data.toString(),
  );
  return job.translations[HEADER.id] as string;
};

function stubSandbox(): void {
  vi.mocked(runSandboxScript).mockImplementation((async (command: string) => {
    if (command === 'extract') {
      return {
        files: new Map([
          [
            'units.json',
            strToU8(
              JSON.stringify({
                pageCount: 1,
                pages: [
                  {
                    page: 1,
                    width: 500,
                    height: 700,
                    units: 1,
                    textChars: 14,
                    scanned: false,
                  },
                ],
                units: [HEADER],
              }),
            ),
          ],
          ['page_1.png', strToU8('png')],
        ]),
      };
    }
    return {
      files: new Map([
        [
          'report.json',
          strToU8(
            JSON.stringify({
              fonts: { sans: 'A', serif: 'B' },
              units: [
                {
                  id: HEADER.id,
                  page: 1,
                  n: 1,
                  scale: 1,
                  fits: true,
                  used: HEADER.room,
                },
              ],
            }),
          ),
        ],
        ['translated.pdf', strToU8('%PDF-out')],
        ['preview_1.png', strToU8('png')],
        ['check_1.png', strToU8('png')],
      ]),
    };
  }) as never);
}

/** Stubs the models; the translator words the header as `translated`. */
function stubModels(translated: string): void {
  vi.mocked(callStructured).mockImplementation((async (call: {
    usageLabel: string;
  }) => {
    if (call.usageLabel === 'native-pdf-analyze') {
      return {
        pageNotes: '',
        names: [],
        units: [{ n: 1, role: 'heading', translate: true, note: '' }],
      };
    }
    if (call.usageLabel === 'native-pdf-translate') {
      return { units: [{ id: HEADER.id, text: translated }] };
    }
    if (call.usageLabel === 'native-pdf-verify') return { issues: [] };
    throw new Error(`unexpected model call ${call.usageLabel}`);
  }) as never);
}

const run = () =>
  runNativePdfTranslation({
    document: Buffer.from('%PDF-1.4'),
    targetLanguage: 'French',
    pages: [1],
    instructions: {},
    modelId: 'model',
    maxRefitRounds: 0,
    depth: 'quick',
    glossaryEntries: [],
    brief: BRIEF,
    usage: {} as never,
  });

describe('runNativePdfTranslation: a term keeps its unit’s line breaks', () => {
  beforeEach(() => {
    vi.mocked(runSandboxScript).mockReset();
    vi.mocked(callStructured).mockReset();
    stubSandbox();
  });

  it('breaks the brief’s wording where the translator broke the line', async () => {
    stubModels('Délai/\napprouvé');
    await run();
    // The brief's wording, in the header's capitals, on the header's lines.
    expect(laidOut()).toBe('DURÉE/\nAPPROUVÉE');
  });

  it('breaks it like the source when the translator dropped the break', async () => {
    stubModels('Délai approuvé');
    await run();
    expect(laidOut()).toBe('DURÉE/\nAPPROUVÉE');
  });
});
