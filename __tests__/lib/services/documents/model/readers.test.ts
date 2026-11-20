import { DECK_ENGINE_SCRIPT } from '@/lib/services/documents/model/deckEngineScript';
import { DOCX_INSPECT_SCRIPT } from '@/lib/services/documents/model/docxInspectScript';
import { PDF_INSPECT_SCRIPT } from '@/lib/services/documents/model/pdfInspectScript';
import type { SandboxScript } from '@/lib/services/documents/sandbox/sandboxScriptRunner';

import {
  DOCUMENT_MODEL_SCHEME,
  DocumentModel,
  DocumentUnit,
} from '@/lib/utils/shared/documents/documentModel';

import { pythonHas, runLocalScript } from '../../../../helpers/sandboxScript';

import { createHash } from 'crypto';
import { strFromU8 } from 'fflate';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The format readers on the brand fixtures (make_brand_fixtures.py), run
 * on this machine as the sandbox runs them: each document holds text and
 * pictures that follow the brand and text and pictures that break it, so
 * every fact a check relies on is read on both sides.
 */

const FIXTURES = path.join(__dirname, '../../../../fixtures/brand');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const LOGO_SHA = createHash('sha256').update(fixture('logo.png')).digest('hex');

function inspect(
  script: SandboxScript,
  source: string,
  job: Record<string, unknown> = {},
): {
  model?: DocumentModel;
  refused?: { code: string };
  files: Map<string, Uint8Array>;
} {
  const files = runLocalScript(script, 'inspect', [
    { filename: source, data: fixture(`brand.${source.split('.').pop()}`) },
    {
      filename: 'job.json',
      data: Buffer.from(JSON.stringify({ source, ...job })),
    },
  ]);
  const refused = files.get('refused.json');
  if (refused) return { refused: JSON.parse(strFromU8(refused)), files };
  return { model: JSON.parse(strFromU8(files.get('model.json')!)), files };
}

const unitStarting = (model: DocumentModel, text: string): DocumentUnit => {
  const found = model.units.find((unit) => unit.text.startsWith(text));
  if (!found) throw new Error(`no unit "${text}"`);
  return found;
};

describe.skipIf(!pythonHas(['lxml']))(
  'the presentation engine’s inspect',
  () => {
    const { model, files } = inspect(DECK_ENGINE_SCRIPT, 'source.pptx');

    it('reports each run as declared, on brand and off', () => {
      expect(model!.scheme).toBe(DOCUMENT_MODEL_SCHEME);
      expect(model!.format).toBe('pptx');
      expect(unitStarting(model!, 'Northwind annual').runs[0]).toMatchObject({
        font: 'Montserrat',
        size: 28,
        color: '#1b2a41',
      });
      expect(unitStarting(model!, 'Join the').runs[0]).toMatchObject({
        font: 'Comic Sans MS',
        color: '#ff00ff',
      });
      expect(unitStarting(model!, 'Terms apply').runs[0].size).toBe(7);
    });

    it('finds the logo on the slide, in a group, and on the master, with its bytes', () => {
      expect(model!.images).toHaveLength(3);
      expect(model!.images.every((image) => image.sha256 === LOGO_SHA)).toBe(
        true,
      );
      const [kept, grouped, master] = model!.images;
      // 2 x 1 inches and 2 x 0.5 inches: the second is squashed.
      expect(kept.box![2] - kept.box![0]).toBeCloseTo(144, 0);
      expect(kept.box![3] - kept.box![1]).toBeCloseTo(72, 0);
      expect(grouped.box![3] - grouped.box![1]).toBeCloseTo(36, 0);
      expect(master.inherited).toBe('master');
      expect(
        Buffer.from(files.get(master.file)!).equals(fixture('logo.png')),
      ).toBe(true);
    });

    it('reads the theme', () => {
      expect(model!.theme?.colors.accent1).toMatch(/^#[0-9a-f]{6}$/);
      expect(model!.theme?.fonts.minor).toBeTruthy();
    });

    it('gives the same ids for the same deck', () => {
      const again = inspect(DECK_ENGINE_SCRIPT, 'source.pptx').model!;
      expect(again.units.map((u) => u.id)).toEqual(
        model!.units.map((u) => u.id),
      );
      expect(again.images.map((i) => i.id)).toEqual(
        model!.images.map((i) => i.id),
      );
    });
  },
);

describe.skipIf(!pythonHas(['lxml']))('the Word reader', () => {
  const { model } = inspect(DOCX_INSPECT_SCRIPT, 'source.docx');

  it('reports each run as declared, with no page until placed', () => {
    const heading = unitStarting(model!, 'Northwind annual');
    expect(heading.page).toBeNull();
    expect(heading.runs[0]).toMatchObject({
      font: 'Montserrat',
      size: 20,
      color: '#1b2a41',
    });
    expect(unitStarting(model!, 'Join the').runs[0]).toMatchObject({
      font: 'Comic Sans MS',
      color: '#ff00ff',
    });
    expect(unitStarting(model!, 'Terms apply').runs[0].size).toBe(7);
  });

  it('reads the header as its own kind, and the theme', () => {
    const header = model!.units.find((unit) => unit.kind === 'header');
    expect(header?.text).toBe('Northwind');
    expect(header?.runs[0].font).toBe('Montserrat');
    expect(model!.theme?.fonts.minor).toBeTruthy();
  });
});

describe.skipIf(!pythonHas(['fitz']))('the PDF reader', () => {
  const { model, files } = inspect(PDF_INSPECT_SCRIPT, 'source.pdf');

  it('reports each block’s spans as drawn', () => {
    expect(model!.pages).toEqual([{ page: 1, width: 595, height: 842 }]);
    const heading = unitStarting(model!, 'Northwind annual');
    expect(heading.page).toBe(1);
    expect(heading.runs[0]).toMatchObject({
      font: 'Helvetica',
      color: '#1b2a41',
    });
    expect(heading.runs[0].size).toBeCloseTo(20, 1);
    expect(unitStarting(model!, 'Join the').runs[0]).toMatchObject({
      font: 'Courier',
      color: '#ff00ff',
    });
  });

  it('reports every place a picture is drawn, its bytes once', () => {
    const boxes = model!.images.map((image) => image.box);
    expect(boxes).toEqual([
      [50, 300, 250, 400],
      [300, 300, 500, 350],
    ]);
    expect(new Set(model!.images.map((image) => image.file)).size).toBe(1);
    expect(files.get(model!.images[0].file)?.length).toBeGreaterThan(0);
  });

  it('refuses a password-protected PDF', () => {
    const refused = runLocalScript(PDF_INSPECT_SCRIPT, 'inspect', [
      { filename: 'source.pdf', data: fixture('locked.pdf') },
      { filename: 'job.json', data: Buffer.from('{"source":"source.pdf"}') },
    ]).get('refused.json');
    expect(JSON.parse(strFromU8(refused!)).code).toBe('ENCRYPTED');
  });
});

it('ships every program as a raw template without backticks or dollar-braces', () => {
  for (const script of [
    DECK_ENGINE_SCRIPT,
    PDF_INSPECT_SCRIPT,
    DOCX_INSPECT_SCRIPT,
  ]) {
    expect(script.source).not.toContain('`');
    expect(script.source).not.toContain('${');
    expect(script.source.startsWith('"""')).toBe(true);
  }
});
