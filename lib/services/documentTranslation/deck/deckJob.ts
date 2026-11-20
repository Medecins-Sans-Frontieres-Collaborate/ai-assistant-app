/**
 * A deck's way through the document translation service (Text only): made
 * ready when it is submitted, finished when the service is done. See THE
 * MERGE CONVENTION in deckMerge.
 */
import { checkLibreOfficeInput } from '@/lib/services/presentationRender/libreOfficeInputs';
import { getRenderService } from '@/lib/services/presentationRender/renderService';

import {
  DeckPackageType,
  isDeckPackageType,
  makeServiceCopy,
  mergeTranslatedDeck,
} from './deckMerge';
import { DeckFormatError, readDeckSlides } from './deckText';

import fs from 'fs';
import os from 'os';
import path from 'path';

/** The import and export filters a .ppt is converted with. */
const PPT_TO_PPTX = 'pptx:Impress MS PowerPoint 2007 XML';

/** Extension of the copy the service is sent and returns. */
export const DECK_SERVICE_EXTENSION = 'pptx';

/** A deck made ready for the service. */
export interface PreparedDeck {
  /** The deck kept as the job's original: the upload, or the .pptx made from a .ppt. */
  base: Buffer;
  /** What the service is sent: a plain .pptx. */
  serviceCopy: Buffer;
  /** Extension the translation will have. */
  extension: DeckPackageType;
  /** File name the translation is named after (a .ppt's becomes .pptx). */
  filename: string;
  /** Set when the upload was converted from another format. */
  convertedFrom?: 'ppt';
  /** Slides in the deck, hidden ones included. */
  slides: number;
}

/** A private work folder, removed whatever happens. */
async function inWorkDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deck-job-'));
  try {
    return await work(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Makes an uploaded deck ready for the service.
 *
 * @param upload - The uploaded file.
 * @param filename - Its name; the extension says its type.
 * @param signal - Stops a conversion that is waiting or running.
 * @returns The deck to keep, the copy to send and the slide count.
 * @throws DocumentSignatureError when the file is not its type (a
 *   password-protected .pptx is a compound file: DOCUMENT_PROTECTED).
 * @throws DeckFormatError / PackageFormatError when it is not a readable deck.
 * @throws Render service errors while converting a .ppt (busy, timeout).
 */
export async function prepareDeck(
  upload: Buffer,
  filename: string,
  signal?: AbortSignal,
): Promise<PreparedDeck> {
  const extension = path.extname(filename).slice(1).toLowerCase();
  return inWorkDir(async (dir) => {
    // A fixed name inside a private folder: nothing user-supplied reaches
    // a path or a command line.
    const uploadPath = path.join(dir, `upload.${extension}`);
    await fs.promises.writeFile(uploadPath, upload);
    await checkLibreOfficeInput(uploadPath, extension);

    let basePath = uploadPath;
    let type: DeckPackageType;
    let convertedFrom: 'ppt' | undefined;
    if (extension === 'ppt') {
      basePath = await getRenderService().convert({
        inputPath: uploadPath,
        type: 'ppt',
        convertTo: PPT_TO_PPTX,
        outputDir: path.join(dir, 'converted'),
        lane: 'translation',
        signal,
      });
      type = 'pptx';
      convertedFrom = 'ppt';
    } else if (isDeckPackageType(extension)) {
      type = extension;
    } else {
      throw new DeckFormatError(`.${extension} files are not presentations.`);
    }

    const slides = await readDeckSlides(basePath);
    if (slides.length === 0) {
      throw new DeckFormatError('The presentation has no slides.');
    }
    const servicePath = path.join(dir, `service.${DECK_SERVICE_EXTENSION}`);
    await makeServiceCopy(basePath, type, servicePath);
    return {
      base: await fs.promises.readFile(basePath),
      serviceCopy: await fs.promises.readFile(servicePath),
      extension: type,
      filename: convertedFrom
        ? `${path.basename(filename, path.extname(filename))}.pptx`
        : filename,
      ...(convertedFrom && { convertedFrom }),
      slides: slides.length,
    };
  });
}

/**
 * Has LibreOffice open a damaged deck and save it again as a `.pptx`: the
 * repair the fallbacks in POWERPOINT_TRANSLATION.md try once before a deck
 * is refused. What LibreOffice could not read is lost with the damage, and
 * so are a `.pptm`'s macros.
 *
 * @param deck - The damaged deck.
 * @param format - Its type (`pptx`, `pptm`, `ppsx` or `potx`).
 * @param signal - Stops a conversion that is waiting or running.
 * @returns The repaired deck, which has slides.
 * @throws Render service errors when LibreOffice cannot open it either, or
 *   DeckFormatError when what it saved has no slides.
 */
export async function repairDeck(
  deck: Buffer,
  format: DeckPackageType,
  signal?: AbortSignal,
): Promise<Buffer> {
  return inWorkDir(async (dir) => {
    const inputPath = path.join(dir, `damaged.${format}`);
    await fs.promises.writeFile(inputPath, deck);
    const repairedPath = await getRenderService().convert({
      inputPath,
      type: format,
      convertTo: PPT_TO_PPTX,
      outputDir: path.join(dir, 'repaired'),
      lane: 'translation',
      signal,
    });
    if ((await readDeckSlides(repairedPath)).length === 0) {
      throw new DeckFormatError('The repaired presentation has no slides.');
    }
    return fs.promises.readFile(repairedPath);
  });
}

/**
 * Puts the service's translation into the person's deck.
 *
 * @param base - The job's original deck (PreparedDeck.base).
 * @param translated - What the service returned.
 * @param extension - The base's type.
 * @param translateNotes - Whether translated speaker notes are taken.
 * @returns The finished deck.
 */
export async function finishDeck(options: {
  base: Buffer;
  translated: Buffer;
  extension: string;
  translateNotes: boolean;
}): Promise<Buffer> {
  return inWorkDir(async (dir) => {
    const basePath = path.join(dir, `base.${options.extension}`);
    const translatedPath = path.join(
      dir,
      `translated.${DECK_SERVICE_EXTENSION}`,
    );
    const outPath = path.join(dir, `finished.${options.extension}`);
    await fs.promises.writeFile(basePath, options.base);
    await fs.promises.writeFile(translatedPath, options.translated);
    await mergeTranslatedDeck({
      basePath,
      translatedPath,
      outPath,
      translateNotes: options.translateNotes,
    });
    return fs.promises.readFile(outPath);
  });
}
