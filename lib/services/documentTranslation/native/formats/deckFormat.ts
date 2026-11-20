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
import {
  applyDeckEdits,
  extractDeckUnits,
} from '@/lib/services/documents/model/deckEngine';
import {
  documentPagePictures,
  documentPdf,
} from '@/lib/services/documents/render/documentPages';
import { RenderBusyError } from '@/lib/services/documents/render/renderQueue';
import { getRenderService } from '@/lib/services/documents/render/renderService';

import { NativeDeckFormat } from '@/lib/utils/shared/translation/nativeFormats';
import { NativePdfFitReport } from '@/lib/utils/shared/translation/nativePdf';

import { makeServiceCopy, mergeTranslatedDeck } from '../../deck/deckMerge';
import { omitDeckSlides } from '../../deck/deckSlides';
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

const DECK_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

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

/** A private work folder, removed whatever happens. */
async function inWorkDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deck-run-'));
  try {
    return await work(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
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

/**
 * Pictures of source slides, made once per copy and slide (the page
 * pictures are kept by the documents layer).
 *
 * @param servicePath - The plain copy of the source deck.
 * @param slides - 1-based slides.
 */
function sourceSlidePictures(
  servicePath: string,
  slides: number[],
  dir: string,
  context: FormatCallContext,
): Promise<Map<number, Uint8Array>> {
  return documentPagePictures({
    inputPath: servicePath,
    type: 'pptx',
    pages: slides,
    dpi: SLIDE_RENDER_DPI,
    lane: 'background',
    workDir: dir,
    signal: context.signal,
    onPosition: context.onQueue,
  });
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
  const renderedPdf = await documentPdf(input.renderPath, 'pptx', {
    lane: 'background',
    workDir: dir,
    signal: context.signal,
    onPosition: context.onQueue,
  });
  const pdfPages = pictured.map((slide) => kept.indexOf(slide) + 1);
  const translatedPictures = pdfPages.length
    ? await getRenderService().rasterize({
        pdfPath: renderedPdf,
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
  return { pdf: await fs.promises.readFile(renderedPdf), outputs };
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
        const unitsFile = await extractDeckUnits(
          await fs.promises.readFile(servicePath),
          { pages, notes: context.translateNotes !== false },
          context.usage,
        );
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
        const applied = await applyDeckEdits(
          await fs.promises.readFile(servicePath),
          unitsFile,
          {
            text: Object.fromEntries(translations),
            styles: output.styles,
            language: output.language,
          },
          context.usage,
        );
        const report = applied.report as unknown as {
          fonts: { sans: string; serif: string };
          units: NativePdfFitReport[];
        };
        const translatedPath = path.join(dir, 'translated.pptx');
        await fs.promises.writeFile(translatedPath, applied.deck);

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
