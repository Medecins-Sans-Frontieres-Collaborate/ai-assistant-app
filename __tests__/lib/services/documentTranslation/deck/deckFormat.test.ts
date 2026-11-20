import { repairDeck } from '@/lib/services/documentTranslation/deck/deckJob';
import { deckFormat } from '@/lib/services/documentTranslation/native/formats/deckFormat';
import { LibreOfficeFailedError } from '@/lib/services/documents/render/libreOfficeProcess';
import { RenderBusyError } from '@/lib/services/documents/render/renderQueue';
import { InProcessRenderService } from '@/lib/services/documents/render/renderService';
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import {
  deckScriptAvailable,
  runDeckScript,
} from '../../../../helpers/deckScript';

import { execFileSync } from 'child_process';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The presentation adapter end to end on this machine: the shipped deck
 * script stands in for the sandbox (same files in, same archive out), and
 * LibreOffice, pdftoppm and sharp are the real ones.
 */

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/services/documents/sandbox/sandboxScriptRunner', () => ({
  runSandboxScript: vi.fn(
    async (
      command: 'extract' | 'rebuild',
      inputs: Array<{ filename: string; data: Buffer }>,
      _usage: unknown,
      script: { filename: string },
    ) => {
      if (script?.filename !== 'deck_engine.py') {
        throw new Error('only the deck script runs here');
      }
      return {
        files: runDeckScript(command, inputs),
        logs: '',
        durationMs: 0,
      };
    },
  ),
}));
const service = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/services/documents/render/renderService', async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return { ...actual, getRenderService: () => service.current };
});

const has = (command: string, args: string[]) => {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
};
const ready =
  deckScriptAvailable &&
  has('libreoffice', ['--version']) &&
  has('pdftoppm', ['-v']);

const FIXTURES = path.join(__dirname, '../../../../fixtures/pptx');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const usage = () =>
  new WorkflowUsageCollector({ user: { id: 'u' } as never, action: 't' });

/**
 * The same deck in new bytes (re-zipped, with a marker part), so slide
 * pictures cached for the fixture are not found for it.
 */
function uncached(deck: Buffer, marker: string): Buffer {
  const parts = unzipSync(new Uint8Array(deck));
  parts[`customXml/${marker}.xml`] = Buffer.from(`<m>${marker}</m>`);
  return Buffer.from(zipSync(parts));
}

/** A deck declared as another package type (a show or a template). */
function declaredAs(deck: Buffer, contentType: string): Buffer {
  const parts = unzipSync(new Uint8Array(deck));
  parts['[Content_Types].xml'] = Buffer.from(
    strFromU8(parts['[Content_Types].xml']).replace(
      /application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation\.main\+xml/,
      contentType,
    ),
  );
  return Buffer.from(zipSync(parts));
}

describe.skipIf(!ready)(
  'the presentation adapter (python3, LibreOffice, pdftoppm)',
  () => {
    beforeAll(() => {
      service.current = new InProcessRenderService({
        maxConcurrent: 2,
        maxQueued: 20,
        interactiveBurst: 3,
        memoryLimitMb: 4096,
        timeoutBaseMs: 120_000,
        timeoutPerMbMs: 0,
        timeoutMaxMs: 300_000,
        workRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'deck-format-render-')),
      });
    });

    it('extracts units with a labelled picture of each slide', async () => {
      const extraction = await deckFormat('pptx').extract(
        fixture('native.pptx'),
        [1, 8],
        {
          usage: usage(),
        },
      );
      const units = JSON.parse(strFromU8(extraction.unitsFile)) as {
        pages: Array<{ page: number }>;
      };
      expect(units.pages.map((p) => p.page)).toEqual([1, 8]);
      const meta = await sharp(extraction.pageImage(8)!).metadata();
      // 10 in wide at the check resolution, 100 dpi.
      expect(meta.width).toBe(1000);
      expect(() => extraction.pageImage(2)).toThrow();
    }, 180_000);

    it('rebuilds into the person’s package: macros kept, slides left out, slides pictured', async () => {
      const base = fixture('rich.pptm');
      const adapter = deckFormat('pptm');
      const extraction = await adapter.extract(base, [1, 2], {
        usage: usage(),
      });
      const units = JSON.parse(strFromU8(extraction.unitsFile)) as {
        units: Array<{ id: string; text: string; page: number }>;
      };
      const translations = new Map(
        units.units.map((u) => [u.id, `FR ${u.text}`]),
      );
      const queue: number[] = [];
      const built = await adapter.rebuild(
        base,
        extraction.unitsFile,
        translations,
        { omitPages: [4], language: 'fr-FR' },
        { usage: usage(), onQueue: (ahead) => queue.push(ahead) },
      );
      const out = unzipSync(new Uint8Array(built.document!));
      const original = unzipSync(new Uint8Array(base));
      // THE MERGE CONVENTION: the macro part byte for byte, still declared so.
      expect(
        Buffer.from(out['ppt/vbaProject.bin']).equals(
          Buffer.from(original['ppt/vbaProject.bin']),
        ),
      ).toBe(true);
      expect(strFromU8(out['[Content_Types].xml'])).toContain(
        'macroEnabled.main+xml',
      );
      expect(strFromU8(out['ppt/slides/slide1.xml'])).toContain(
        'FR Annual report',
      );
      // Slide 4 (hidden) left out: four slides listed, four PDF pages.
      expect(
        strFromU8(out['ppt/presentation.xml']).match(/<p:sldId /g),
      ).toHaveLength(4);
      const pdfPages = Number(
        /\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/.exec(
          Buffer.from(built.pdf).toString('latin1'),
        )?.[1],
      );
      expect(pdfPages).toBe(4);
      expect(built.outputs.map((o) => o.page)).toEqual([1, 2]);
      const check = await sharp(built.outputs[0].check).metadata();
      const preview = await sharp(built.outputs[0].preview).metadata();
      expect(check.width).toBe(
        2 * Math.round((preview.width! * 100) / 144) + 8,
      );
      expect(queue).toContain(0);
    }, 240_000);

    it('delivers the deck without pictures or the check when rendering fails', async () => {
      const working = service.current;
      const failing = {
        convert: vi.fn(async () => {
          throw new LibreOfficeFailedError(
            'LibreOffice exited with code 1',
            false,
            '',
          );
        }),
        rasterize: vi.fn(),
        snapshot: vi.fn(),
      };
      service.current = failing;
      try {
        const base = uncached(fixture('native.pptx'), 'render-fails');
        const adapter = deckFormat('pptx');
        const extraction = await adapter.extract(base, [1], { usage: usage() });
        // Read from its text alone.
        expect(extraction.pageImage(1)).toBeNull();
        const units = JSON.parse(strFromU8(extraction.unitsFile)) as {
          units: Array<{ id: string; text: string }>;
        };
        const built = await adapter.rebuild(
          base,
          extraction.unitsFile,
          new Map(units.units.map((u) => [u.id, `FR ${u.text}`])),
          {},
          { usage: usage() },
        );
        expect(built.pdf).toBeNull();
        expect(built.outputs).toEqual([]);
        expect(built.unpictured).toEqual([1]);
        expect(
          strFromU8(
            unzipSync(new Uint8Array(built.document!))['ppt/slides/slide1.xml'],
          ),
        ).toContain('FR Annual report');
      } finally {
        service.current = working;
      }
    }, 120_000);

    it('refuses the run when the render queue is full, before anything is charged', async () => {
      const working = service.current;
      service.current = {
        convert: vi.fn(async () => {
          throw new RenderBusyError(50);
        }),
      };
      try {
        await expect(
          deckFormat('pptx').extract(
            uncached(fixture('native.pptx'), 'busy'),
            [1],
            {
              usage: usage(),
            },
          ),
        ).rejects.toBeInstanceOf(RenderBusyError);
      } finally {
        service.current = working;
      }
    }, 120_000);

    it('passes a stop on rather than delivering without pictures', async () => {
      const working = service.current;
      const stop = new AbortController();
      service.current = {
        convert: vi.fn(async () => {
          stop.abort(new Error('stopped'));
          throw new Error('stopped');
        }),
      };
      try {
        await expect(
          deckFormat('pptx').extract(
            uncached(fixture('native.pptx'), 'stopped'),
            [1],
            {
              usage: usage(),
              signal: stop.signal,
            },
          ),
        ).rejects.toThrow('stopped');
      } finally {
        service.current = working;
      }
    }, 120_000);

    it('refuses a deck with a broken slide, and takes it once LibreOffice repaired it', async () => {
      const parts = unzipSync(new Uint8Array(fixture('native.pptx')));
      const slide = parts['ppt/slides/slide2.xml'];
      parts['ppt/slides/slide2.xml'] = slide.slice(
        0,
        Math.floor(slide.length / 2),
      );
      const damaged = Buffer.from(zipSync(parts));
      await expect(
        deckFormat('pptx').extract(damaged, [1, 2], { usage: usage() }),
      ).rejects.toMatchObject({ name: 'DeckRefusedError', code: 'DAMAGED' });
      const repaired = await repairDeck(damaged, 'pptx');
      const extraction = await deckFormat('pptx').extract(repaired, [1, 2], {
        usage: usage(),
      });
      const units = JSON.parse(strFromU8(extraction.unitsFile)) as {
        units: Array<{ text: string }>;
      };
      expect(units.units.map((unit) => unit.text)).toContain('Annual report');
    }, 240_000);

    it.each([
      [
        'ppsx',
        'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
      ],
      [
        'potx',
        'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
      ],
    ] as const)(
      'keeps a .%s declared as one',
      async (format, contentType) => {
        const base = declaredAs(fixture('native.pptx'), contentType);
        const adapter = deckFormat(format);
        const extraction = await adapter.extract(base, [8], { usage: usage() });
        const units = JSON.parse(strFromU8(extraction.unitsFile)) as {
          units: Array<{ id: string; text: string }>;
        };
        const built = await adapter.rebuild(
          base,
          extraction.unitsFile,
          new Map(units.units.map((u) => [u.id, `FR ${u.text}`])),
          { imagePages: [] },
          { usage: usage() },
        );
        const types = strFromU8(
          unzipSync(new Uint8Array(built.document!))['[Content_Types].xml'],
        );
        expect(types).toContain(contentType);
        expect(built.outputs).toEqual([]);
      },
      240_000,
    );
  },
);
