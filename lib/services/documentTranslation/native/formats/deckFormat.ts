/**
 * The presentation adapter (see THE FORMAT ADAPTER).
 *
 *   extract   the deck script reads the units in the sandbox; the slides
 *             are rendered through the render service and the labelled
 *             images drawn here
 *   rebuild   the deck script writes the translations in the sandbox; the
 *             result is put into the person's own package (THE MERGE
 *             CONVENTION in deckMerge.ts), slides they removed are left
 *             out, and the deck is rendered to a PDF and slide pictures
 *
 * The sandbox and LibreOffice only ever see a plain `.pptx` copy
 * (makeServiceCopy): macros never leave the app's storage. Every rebuild
 * starts from the original deck.
 */
import { RenderBusyError } from '@/lib/services/documents/render/renderQueue';
import { getRenderService } from '@/lib/services/documents/render/renderService';

import Hasher from '@/lib/utils/app/hash';
import { NativeDeckFormat } from '@/lib/utils/shared/translation/nativeFormats';
import { NativePdfFitReport } from '@/lib/utils/shared/translation/nativePdf';

import { makeServiceCopy, mergeTranslatedDeck } from '../../deck/deckMerge';
import { omitDeckSlides } from '../../deck/deckSlides';
import { DECK_SANDBOX_SCRIPT } from '../pptxNativeScript';
import { runSandboxScript } from '../sandboxScriptRunner';
import {
  DrawnUnit,
  SLIDE_RENDER_DPI,
  checkImage,
  labelledSlide,
} from './deckImages';
import {
  FormatCallContext,
  FormatExtraction,
  NativeFormatAdapter,
  RebuildOutcome,
  requireFile,
} from './nativeFormat';
import { jobFile } from './pdfFormat';

import { strFromU8 } from 'fflate';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SOURCE_FILENAME = 'source.pptx';
const UNITS_FILENAME = 'units.json';
const DECK_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Source slide pictures kept between an extraction and its rebuilds. */
const SOURCE_PICTURES_KEPT = 120;

/** A deck the script refused to open, with its typed reason. */
export class DeckRefusedError extends Error {
  constructor(
    /** ENCRYPTED, DAMAGED, DOCTYPE, ZIP_BOMB or TOO_LARGE. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeckRefusedError';
  }
}

/** What a deck unit carries besides the shared unit fields. */
interface DeckUnitRecord {
  id: string;
  page: number;
  n: number;
  bbox: [number, number, number, number];
  room: [number, number, number, number];
  deck?: { notes?: boolean; kind?: string };
}

interface DeckExtraction {
  pageCount: number;
  pages: Array<{ page: number }>;
  units: DeckUnitRecord[];
}

/**
 * The export filter for a deck: hidden slides included, so PDF page n is
 * slide n (THE SLIDE NUMBER CONVENTION), and optionally only some slides,
 * in ascending order.
 */
export function deckPdfExport(slides?: readonly number[]): string {
  const options: Record<string, { type: string; value: string }> = {
    ExportHiddenSlides: { type: 'boolean', value: 'true' },
  };
  if (slides?.length) {
    options.PageRange = {
      type: 'string',
      value: [...new Set(slides)].sort((a, b) => a - b).join(','),
    };
  }
  return `pdf:impress_pdf_Export:${JSON.stringify(options)}`;
}

/** A private work folder, removed whatever happens. */
async function inWorkDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deck-run-'));
  try {
    return await work(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/** Throws the script's refusal, when it refused. */
function throwIfRefused(files: Map<string, Uint8Array>): void {
  const refused = files.get('refused.json');
  if (!refused) return;
  const reason = JSON.parse(strFromU8(refused)) as {
    code?: string;
    message?: string;
  };
  throw new DeckRefusedError(
    reason.code ?? 'DAMAGED',
    reason.message ?? 'The presentation could not be read.',
  );
}

/** Units drawn on a slide picture: not notes, not chart strings, with a box. */
function drawnUnits(
  units: DeckUnitRecord[],
  page: number,
  box: 'bbox' | 'room',
  only?: ReadonlySet<string>,
): DrawnUnit[] {
  return units
    .filter(
      (unit) =>
        unit.page === page &&
        !unit.deck?.notes &&
        unit.deck?.kind !== 'value' &&
        unit[box][2] > unit[box][0] &&
        (!only || only.has(unit.id)),
    )
    .map((unit) => ({ n: unit.n, box: unit[box] }));
}

// Pictures of source slides, by the copy's hash and slide: an extraction
// makes them and the rebuilds of its rounds use them for the check.
const sourcePictures = new Map<string, Uint8Array>();

function keepPicture(key: string, png: Uint8Array): void {
  sourcePictures.delete(key);
  sourcePictures.set(key, png);
  while (sourcePictures.size > SOURCE_PICTURES_KEPT) {
    const oldest = sourcePictures.keys().next().value;
    if (oldest === undefined) break;
    sourcePictures.delete(oldest);
  }
}

/**
 * Renders some slides of a deck and pictures them.
 *
 * @param deckPath - A plain `.pptx` copy.
 * @param slides - 1-based slides; absent renders and pictures every slide.
 * @param dir - Work folder.
 * @returns The PDF's path and each slide's PNG by slide number.
 */
async function renderSlides(
  deckPath: string,
  slides: number[] | undefined,
  dir: string,
  context: FormatCallContext,
  pictured: number[],
): Promise<{ pdfPath: string; pictures: Map<number, Uint8Array> }> {
  const render = getRenderService();
  const pdfPath = await render.convert({
    inputPath: deckPath,
    type: 'pptx',
    convertTo: deckPdfExport(slides),
    outputDir: path.join(dir, `render-${path.basename(deckPath, '.pptx')}`),
    lane: 'background',
    signal: context.signal,
    onPosition: context.onQueue,
  });
  const order = slides ? [...new Set(slides)].sort((a, b) => a - b) : undefined;
  // PDF page of each slide: with a range, the slides in ascending order.
  const pdfPageOf = (slide: number) =>
    order ? order.indexOf(slide) + 1 : slide;
  const wanted = pictured.filter((slide) => pdfPageOf(slide) > 0);
  const pngs = wanted.length
    ? await render.rasterize({
        pdfPath,
        pages: wanted.map(pdfPageOf),
        dpi: SLIDE_RENDER_DPI,
        outputDir: path.join(
          dir,
          `pictures-${path.basename(deckPath, '.pptx')}`,
        ),
        lane: 'background',
        signal: context.signal,
        onPosition: context.onQueue,
      })
    : new Map<number, string>();
  const pictures = new Map<number, Uint8Array>();
  for (const slide of wanted) {
    const file = pngs.get(pdfPageOf(slide));
    if (file) pictures.set(slide, await fs.promises.readFile(file));
  }
  return { pdfPath, pictures };
}

/**
 * Pictures of source slides, made once per copy and slide.
 *
 * @param servicePath - The plain copy of the source deck.
 * @param slides - 1-based slides.
 */
async function sourceSlidePictures(
  servicePath: string,
  slides: number[],
  dir: string,
  context: FormatCallContext,
): Promise<Map<number, Uint8Array>> {
  const hash = Hasher.sha256(await fs.promises.readFile(servicePath));
  const found = new Map<number, Uint8Array>();
  const missing: number[] = [];
  for (const slide of slides) {
    const cached = sourcePictures.get(`${hash}:${slide}`);
    if (cached) found.set(slide, cached);
    else missing.push(slide);
  }
  if (missing.length > 0) {
    const { pictures } = await renderSlides(
      servicePath,
      missing,
      dir,
      context,
      missing,
    );
    for (const [slide, png] of pictures) {
      keepPicture(`${hash}:${slide}`, png);
      found.set(slide, png);
    }
  }
  return found;
}

/**
 * The translated deck as a PDF, and the pictures of some slides beside
 * their originals.
 *
 * @param kept - The slides the result holds, in order (the PDF's pages).
 * @param pictured - Source slides to picture; each must be kept.
 * @throws Render service errors (busy, timeout, failure, abort).
 */
async function pictureResult(input: {
  renderPath: string;
  servicePath: string;
  dir: string;
  context: FormatCallContext;
  kept: number[];
  pictured: number[];
  units: DeckUnitRecord[];
  laidOut: ReadonlySet<string>;
}): Promise<{ pdf: Uint8Array; outputs: RebuildOutcome['outputs'] }> {
  const { dir, context, kept, pictured } = input;
  // The rendered PDF holds the kept slides in order; they are pictured by
  // their place in it and each picture named by its source slide.
  const rendered = await renderSlides(
    input.renderPath,
    undefined,
    dir,
    context,
    [],
  );
  const pdfPages = pictured.map((slide) => kept.indexOf(slide) + 1);
  const translatedPictures = pdfPages.length
    ? await getRenderService().rasterize({
        pdfPath: rendered.pdfPath,
        pages: pdfPages,
        dpi: SLIDE_RENDER_DPI,
        outputDir: path.join(dir, 'translated-pictures'),
        lane: 'background',
        signal: context.signal,
        onPosition: context.onQueue,
      })
    : new Map<number, string>();
  const originals = await sourceSlidePictures(
    input.servicePath,
    pictured,
    dir,
    context,
  );
  const outputs = await Promise.all(
    pictured.map(async (slide, index) => {
      const file = translatedPictures.get(pdfPages[index]);
      if (!file) throw new Error(`Slide ${slide} was not pictured`);
      const preview = await fs.promises.readFile(file);
      const original = originals.get(slide) ?? preview;
      return {
        page: slide,
        preview,
        check: await checkImage(
          original,
          preview,
          drawnUnits(input.units, slide, 'room', input.laidOut),
        ),
      };
    }),
  );
  return { pdf: await fs.promises.readFile(rendered.pdfPath), outputs };
}

/**
 * The adapter for one presentation format.
 *
 * @param format - The run's source format: what the translated deck is.
 */
export function deckFormat(format: NativeDeckFormat): NativeFormatAdapter {
  /** Writes the person's deck and its plain copy into a work folder. */
  const prepare = async (dir: string, document: Buffer) => {
    const basePath = path.join(dir, `base.${format}`);
    const servicePath = path.join(dir, SOURCE_FILENAME);
    await fs.promises.writeFile(basePath, document);
    await makeServiceCopy(basePath, format, servicePath);
    return { basePath, servicePath };
  };

  return {
    format,

    async extract(document, pages, context): Promise<FormatExtraction> {
      return inWorkDir(async (dir) => {
        const { servicePath } = await prepare(dir, document);
        const run = await runSandboxScript(
          'extract',
          [
            {
              filename: SOURCE_FILENAME,
              data: await fs.promises.readFile(servicePath),
              mimeType: DECK_CONTENT_TYPE,
            },
            jobFile({
              source: SOURCE_FILENAME,
              pages,
              notes: context.translateNotes !== false,
            }),
          ],
          context.usage,
          DECK_SANDBOX_SCRIPT,
        );
        throwIfRefused(run.files);
        const unitsFile = requireFile(run.files, UNITS_FILENAME);
        const extracted = JSON.parse(strFromU8(unitsFile)) as DeckExtraction;
        const slides = extracted.pages.map((page) => page.page);
        // Pictures help the reading of each slide but are not needed for
        // it: when the slides cannot be rendered they are read from their
        // text alone (the fallbacks in POWERPOINT_TRANSLATION.md).
        let pictures = new Map<number, Uint8Array>();
        try {
          pictures = await sourceSlidePictures(
            servicePath,
            slides,
            dir,
            context,
          );
        } catch (error) {
          // A full queue refuses the run while nothing has been charged yet
          // ("busy, try again shortly"); a stop is passed on.
          if (context.signal?.aborted || error instanceof RenderBusyError) {
            throw error;
          }
          console.warn('[deckFormat] Picturing the slides failed:', error);
        }
        const labelled = new Map<number, Uint8Array>();
        await Promise.all(
          slides.map(async (slide) => {
            const picture = pictures.get(slide);
            if (!picture) return;
            labelled.set(
              slide,
              await labelledSlide(
                picture,
                drawnUnits(extracted.units, slide, 'bbox'),
              ),
            );
          }),
        );
        return {
          unitsFile,
          pageImage: (page) => {
            if (!slides.includes(page)) {
              throw new Error(`Slide ${page} was not read`);
            }
            return labelled.get(page) ?? null;
          },
        };
      });
    },

    async rebuild(
      document,
      unitsFile,
      translations,
      output,
      context,
    ): Promise<RebuildOutcome> {
      return inWorkDir(async (dir) => {
        const { basePath, servicePath } = await prepare(dir, document);
        const extracted = JSON.parse(strFromU8(unitsFile)) as DeckExtraction;
        const run = await runSandboxScript(
          'rebuild',
          [
            {
              filename: SOURCE_FILENAME,
              data: await fs.promises.readFile(servicePath),
              mimeType: DECK_CONTENT_TYPE,
            },
            {
              filename: UNITS_FILENAME,
              data: Buffer.from(unitsFile),
              mimeType: 'application/json',
            },
            jobFile({
              source: SOURCE_FILENAME,
              units: UNITS_FILENAME,
              translations: Object.fromEntries(translations),
              ...(output.styles && Object.keys(output.styles).length > 0
                ? { styles: output.styles }
                : {}),
              ...(output.language ? { language: output.language } : {}),
            }),
          ],
          context.usage,
          DECK_SANDBOX_SCRIPT,
        );
        throwIfRefused(run.files);
        const report = JSON.parse(
          strFromU8(requireFile(run.files, 'report.json')),
        ) as {
          fonts: { sans: string; serif: string };
          units: NativePdfFitReport[];
        };
        const translatedPath = path.join(dir, 'translated.pptx');
        await fs.promises.writeFile(
          translatedPath,
          requireFile(run.files, 'translated.pptx'),
        );

        // THE MERGE CONVENTION: the person's package with the written parts in.
        const mergedPath = path.join(dir, `merged.${format}`);
        await mergeTranslatedDeck({
          basePath,
          translatedPath,
          outPath: mergedPath,
          translateNotes: true,
        });
        const omitted = [...new Set(output.omitPages ?? [])].filter(
          (slide) => slide >= 1 && slide <= extracted.pageCount,
        );
        let finalPath = mergedPath;
        if (omitted.length > 0) {
          finalPath = path.join(dir, `final.${format}`);
          await omitDeckSlides(mergedPath, finalPath, omitted);
        }

        // What is rendered is a plain copy of what the person gets.
        const renderPath = path.join(dir, 'result.pptx');
        await makeServiceCopy(finalPath, format, renderPath);
        const kept = Array.from(
          { length: extracted.pageCount },
          (_, index) => index + 1,
        ).filter((slide) => !omitted.includes(slide));
        const pictured = [...new Set(report.units.map((unit) => unit.page))]
          .filter(
            (slide) =>
              kept.includes(slide) &&
              (!output.imagePages || output.imagePages.includes(slide)),
          )
          .sort((a, b) => a - b);
        const deliverable = await fs.promises.readFile(finalPath);
        try {
          const { pdf, outputs } = await pictureResult({
            renderPath,
            servicePath,
            dir,
            context,
            kept,
            pictured,
            units: extracted.units,
            laidOut: new Set(translations.keys()),
          });
          return {
            fits: report.units,
            fonts: report.fonts,
            pdf,
            exports: {},
            document: deliverable,
            outputs,
          };
        } catch (error) {
          // A stop is passed on; any other render failure delivers the deck
          // without its pictures, its slides listed as unchecked.
          if (context.signal?.aborted) throw error;
          console.warn(
            '[deckFormat] Rendering the translated deck failed:',
            error,
          );
          return {
            fits: report.units,
            fonts: report.fonts,
            pdf: null,
            exports: {},
            document: deliverable,
            outputs: [],
            unpictured: pictured,
          };
        }
      });
    },
  };
}
