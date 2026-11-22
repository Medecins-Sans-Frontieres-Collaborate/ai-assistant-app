import {
  DocumentRefusedError,
  inspectDocument,
} from '@/lib/services/documents/model/inspect';
import { InProcessRenderService } from '@/lib/services/documents/render/renderService';

import { pythonHas, runLocalScript } from '../../../../helpers/sandboxScript';

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/**
 * inspectDocument end to end on this machine: the shipped readers stand in
 * for the sandbox (same files in, same archive out) and LibreOffice is the
 * real one, so a Word document is read, rendered and placed for real.
 */

vi.mock('@/config/environment', () => ({ env: {} }));
const sandbox = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock(
  '@/lib/services/documents/sandbox/sandboxScriptRunner',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    runSandboxScript: vi.fn(
      async (
        command: string,
        inputs: Array<{ filename: string; data: Buffer }>,
        _usage: unknown,
        script: Parameters<typeof runLocalScript>[0],
      ) => {
        sandbox.calls.push(script.filename);
        return {
          files: runLocalScript(script, command, inputs),
          logs: '',
          durationMs: 0,
        };
      },
    ),
  }),
);
const service = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/services/documents/render/renderService', async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return { ...actual, getRenderService: () => service.current };
});

const hasLibreOffice = (() => {
  try {
    execFileSync('libreoffice', ['--version'], {
      stdio: 'ignore',
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
})();
const readersReady = pythonHas(['lxml', 'fitz']);

const FIXTURES = path.join(__dirname, '../../../../fixtures/brand');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

let workDir = '';
beforeEach(() => {
  sandbox.calls = [];
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-test-'));
});
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});
const context = () => ({ lane: 'background' as const, workDir });

describe('inspectDocument without readers', () => {
  it('refuses a type it does not read, before any work', async () => {
    await expect(
      inspectDocument(Buffer.from('x'), 'xlsx', context()),
    ).rejects.toThrow('.xlsx cannot be read');
    expect(sandbox.calls).toEqual([]);
  });
});

describe.skipIf(!readersReady)('inspectDocument', () => {
  it('reads a deck with the presentation engine', async () => {
    const { model, imageFile } = await inspectDocument(
      fixture('brand.pptx'),
      'PPTX',
      context(),
    );
    expect(sandbox.calls).toEqual(['deck_engine.py']);
    expect(model.format).toBe('pptx');
    expect(model.images).toHaveLength(3);
    expect(imageFile(model.images[0].file)?.length).toBeGreaterThan(0);
    expect(imageFile('images/missing.png')).toBeNull();
  });

  it('reads a PDF with the PDF reader', async () => {
    const { model } = await inspectDocument(
      fixture('brand.pdf'),
      'pdf',
      context(),
    );
    expect(sandbox.calls).toEqual(['pdf_inspect.py']);
    expect(model.units.every((unit) => unit.page === 1)).toBe(true);
  });

  it('passes on a refusal as a DocumentRefusedError', async () => {
    await expect(
      inspectDocument(fixture('locked.pdf'), 'pdf', context()),
    ).rejects.toMatchObject({
      name: 'DocumentRefusedError',
      code: 'ENCRYPTED',
    });
    await expect(
      inspectDocument(fixture('locked.pdf'), 'pdf', context()),
    ).rejects.toBeInstanceOf(DocumentRefusedError);
  });

  describe.skipIf(!hasLibreOffice)('with LibreOffice', () => {
    beforeAll(() => {
      service.current = new InProcessRenderService({
        maxConcurrent: 1,
        maxQueued: 10,
        interactiveBurst: 1,
        memoryLimitMb: 4096,
        timeoutBaseMs: 120_000,
        timeoutPerMbMs: 0,
        timeoutMaxMs: 300_000,
        workRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-render-')),
      });
    });

    it('places a Word document’s declared paragraphs on its rendered pages', async () => {
      const { model, imageFile } = await inspectDocument(
        fixture('brand.docx'),
        'docx',
        context(),
      );
      expect(sandbox.calls).toEqual(['docx_inspect.py', 'pdf_inspect.py']);
      expect(model.format).toBe('docx');
      expect(model.pageCount).toBeGreaterThanOrEqual(1);
      const body = model.units.filter((unit) => unit.kind === 'body');
      expect(body.length).toBe(5);
      // Every body paragraph found on the page, with its declared font.
      for (const unit of body) {
        expect(unit.page).toBe(1);
        expect(unit.box).not.toBeNull();
      }
      const offBrand = body.find((unit) => unit.text.startsWith('Join'));
      expect(offBrand?.runs[0].font).toBe('Comic Sans MS');
      // Pictures with their places come from the rendering.
      expect(model.images.length).toBeGreaterThanOrEqual(2);
      expect(imageFile(model.images[0].file)?.length).toBeGreaterThan(0);
    }, 300_000);

    it('converts a legacy Word document first', async () => {
      const docx = path.join(workDir, 'brand.docx');
      fs.copyFileSync(path.join(FIXTURES, 'brand.docx'), docx);
      execFileSync(
        'libreoffice',
        ['--headless', '--convert-to', 'doc', '--outdir', workDir, docx],
        { stdio: 'ignore', timeout: 120_000 },
      );
      const { model } = await inspectDocument(
        fs.readFileSync(path.join(workDir, 'brand.doc')),
        'doc',
        context(),
      );
      expect(model.format).toBe('docx');
      expect(
        model.units.some((unit) => unit.text.startsWith('Northwind annual')),
      ).toBe(true);
    }, 300_000);
  });
});
