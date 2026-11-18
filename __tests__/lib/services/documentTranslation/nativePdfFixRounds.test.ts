import { runNativePdfTranslation } from '@/lib/services/documentTranslation/native/nativePdfPipeline';
import { runSandboxScript } from '@/lib/services/documentTranslation/native/sandboxScriptRunner';
import { callStructured } from '@/lib/services/workflows/shared/workflowLlm';

import { strFromU8, strToU8 } from 'fflate';
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
 * The fix rounds of a run: what the check prescribes is applied, the page
 * is laid out and checked again, and a page a round made worse is put back.
 * The sandbox and the models are stubbed; what is asserted is what the
 * pipeline sends them and what it reports.
 */

const SOURCE_SIZE = 20;
const UNITS = [1, 2].map((n) => ({
  id: `p1-b0-${n}`,
  page: 1,
  n,
  text: `source text number ${n}`,
  tags: {},
  chars: 20,
  size: SOURCE_SIZE,
  color: '#000000',
  lines: 1,
  roomFactor: 1.5,
  bbox: [10, 10 * n, 110, 10 * n + 8],
  room: [10, 10 * n, 160, 10 * n + 12],
}));
const EXTRACTION = {
  pageCount: 1,
  pages: [
    {
      page: 1,
      width: 500,
      height: 700,
      units: 2,
      textChars: 40,
      scanned: false,
    },
  ],
  units: UNITS,
};

type Issue = {
  n: number | null;
  kind: string;
  severity: 'minor' | 'major';
  note: string;
  fix: { action: string; percent: number; dx: number; dy: number };
};
const finding = (
  n: number,
  fix: Partial<Issue['fix']>,
  severity: Issue['severity'] = 'major',
): Issue => ({
  n,
  kind: 'overflow',
  severity,
  note: 'runs over',
  fix: { action: 'none', percent: 100, dx: 0, dy: 0, ...fix },
});

/** Every rebuild job the pipeline sent, in order. */
const rebuildJobs = () =>
  vi
    .mocked(runSandboxScript)
    .mock.calls.filter(([command]) => command === 'rebuild')
    .map(([, files]) =>
      JSON.parse(
        files.find((file) => file.filename === 'job.json')?.data.toString() ??
          '{}',
      ),
    );
/** The check's messages, in order: what it was told beside the picture. */
const checkMessages = () =>
  vi
    .mocked(callStructured)
    .mock.calls.filter(([call]) => call.usageLabel === 'native-pdf-verify')
    .map(([call]) => (call.user as Array<{ text?: string }>)[0].text ?? '');

/**
 * Stubs the models. `checks` are the check's answers in order; the last
 * one repeats.
 */
function stubModels(checks: Issue[][]): void {
  let checked = 0;
  vi.mocked(callStructured).mockImplementation((async (call: {
    usageLabel: string;
    user: unknown;
  }) => {
    if (call.usageLabel === 'native-pdf-analyze') {
      return {
        pageNotes: '',
        units: UNITS.map((unit) => ({
          n: unit.n,
          role: 'body',
          translate: true,
          note: '',
        })),
      };
    }
    if (call.usageLabel === 'native-pdf-translate') {
      return {
        units: UNITS.map((unit) => ({
          id: unit.id,
          text: `une traduction assez longue ${unit.n}`,
        })),
      };
    }
    if (call.usageLabel === 'native-pdf-verify') {
      const issues = checks[Math.min(checked, checks.length - 1)];
      checked += 1;
      return { issues };
    }
    if (call.usageLabel === 'native-pdf-refit') {
      const asked = JSON.parse(
        String(call.user).split('Units:\n')[1],
      ) as Array<{ id: string }>;
      return { units: asked.map(({ id }) => ({ id, text: 'plus court' })) };
    }
    throw new Error(`unexpected model call ${call.usageLabel}`);
  }) as never);
}

function stubSandbox(): void {
  vi.mocked(runSandboxScript).mockImplementation((async (command: string) => {
    if (command === 'extract') {
      return {
        files: new Map([
          ['units.json', strToU8(JSON.stringify(EXTRACTION))],
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
              units: UNITS.map((unit) => ({
                id: unit.id,
                page: 1,
                n: unit.n,
                scale: 1,
                fits: true,
                used: unit.room,
              })),
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

const run = (maxRefitRounds: number) =>
  runNativePdfTranslation({
    document: Buffer.from('%PDF-1.4'),
    targetLanguage: 'French',
    pages: [1],
    instructions: {},
    modelId: 'model',
    maxRefitRounds,
    depth: 'quick',
    glossaryEntries: [],
    usage: {} as never,
  });

describe('runNativePdfTranslation: fix rounds', () => {
  beforeEach(() => {
    vi.mocked(runSandboxScript).mockReset();
    vi.mocked(callStructured).mockReset();
    stubSandbox();
  });

  it("applies a smaller font and a move, then reports them as the units' looks", async () => {
    stubModels([
      [
        finding(1, { action: 'smaller', percent: 90 }),
        finding(2, { action: 'move', dx: 0, dy: 6 }),
      ],
      [],
    ]);
    const result = await run(2);
    const jobs = rebuildJobs();
    // The first layout has no looks; the second carries the fixes.
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).not.toHaveProperty('styles');
    expect(jobs[1].styles).toEqual({
      'p1-b0-1': { size: SOURCE_SIZE * 0.9 },
      'p1-b0-2': { dy: 6 },
    });
    expect(result.styles).toEqual(jobs[1].styles);
    expect(result.refitRounds).toBe(1);
    expect(result.issues).toEqual([]);
    // No wording changed, so no unit counts as shortened.
    expect(result.units.every((unit) => !unit.refitted)).toBe(true);
    expect(result.steps.at(-1)?.detail).toContain('1 set smaller, 1 moved');
  });

  it("tells the check the page size and each unit's measurements", async () => {
    stubModels([[finding(1, { action: 'smaller', percent: 90 })], []]);
    await run(1);
    const [first, second] = checkMessages();
    expect(first).toContain('500 by 700 points');
    expect(first).toContain(`1: ${SOURCE_SIZE} pt`);
    // The recheck is told the size the fix set.
    expect(second).toContain(`1: ${SOURCE_SIZE * 0.9} pt`);
  });

  it('shortens what the check says to shorten, to the prescribed share', async () => {
    stubModels([[finding(1, { action: 'shorten', percent: 60 })], []]);
    const result = await run(1);
    const asked = vi
      .mocked(callStructured)
      .mock.calls.find(([call]) => call.usageLabel === 'native-pdf-refit');
    expect(String(asked?.[0].user)).toContain('"id":"p1-b0-1"');
    expect(String(asked?.[0].user)).not.toContain('"id":"p1-b0-2"');
    const [first, second] = result.units;
    expect(first).toMatchObject({ translation: 'plus court', refitted: true });
    expect(second.refitted).toBe(false);
    expect(result.styles).toEqual({});
  });

  it('puts a page back when a round made it worse, and leaves it alone after', async () => {
    const original = [finding(1, { action: 'move', dx: 10, dy: 0 })];
    stubModels([
      original,
      // After the move: two major findings where there was one.
      [
        finding(1, { action: 'move', dx: 10, dy: 0 }),
        finding(2, { action: 'smaller', percent: 80 }),
      ],
    ]);
    const result = await run(2);
    const jobs = rebuildJobs();
    // First layout, the fix, and the layout that takes the fix back out.
    expect(jobs).toHaveLength(3);
    expect(jobs[1].styles).toEqual({ 'p1-b0-1': { dx: 10 } });
    expect(jobs[2]).not.toHaveProperty('styles');
    expect(result.styles).toEqual({});
    // The findings reported are those of the page as it stands.
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ n: 1, severity: 'major' });
    expect(result.issues[0]).not.toHaveProperty('fix');
    // A second round was allowed, but the page is not tried again.
    expect(result.refitRounds).toBe(1);
    expect(result.steps.at(-1)?.detail).toContain('undone on page 1');
  });

  it('keeps a fix that left the page no worse', async () => {
    const same = [finding(1, { action: 'move', dx: 10, dy: 0 })];
    stubModels([same, [finding(1, { action: 'none' })]]);
    const result = await run(1);
    expect(rebuildJobs()).toHaveLength(2);
    expect(result.styles).toEqual({ 'p1-b0-1': { dx: 10 } });
  });

  it('fixes nothing when no rounds are allowed', async () => {
    stubModels([[finding(1, { action: 'smaller', percent: 80 })]]);
    const result = await run(0);
    expect(rebuildJobs()).toHaveLength(1);
    expect(result.styles).toEqual({});
    expect(result.issues).toHaveLength(1);
    expect(result.steps.at(-1)?.status).toBe('skipped');
  });
});
