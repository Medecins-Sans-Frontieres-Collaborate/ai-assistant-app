/**
 * Decks through the document translation service (Text only).
 *
 * THE MERGE CONVENTION: the deck a person gets back is THEIR package with
 * the translated text parts put in, never the service's package. The
 * service returns the same parts it was given (measured: none added or
 * removed), so its slides, notes, charts, layouts and masters are taken
 * part for part, and everything else stays the person's: relationships,
 * content types, media, macros. Speaker notes are taken only when asked
 * for; the service always translates them.
 *
 * The service is sent a plain `.pptx` (`makeServiceCopy`): a macro-enabled
 * deck, a show or a template is declared a presentation, and its macros are
 * left out, so they never leave the app's storage.
 */
import {
  PackageEntry,
  readPackageDirectory,
  readPackagePart,
  writePackage,
} from '@/lib/services/documents/render/ooxmlPackage';

import { MAX_DECK_XML_BYTES, readDeckSlides, relsPartOf } from './deckText';

import fs from 'fs';

/** Deck types sent to the service directly or as a copy. */
export const DECK_PACKAGE_TYPES = ['pptx', 'pptm', 'ppsx', 'potx'] as const;
export type DeckPackageType = (typeof DECK_PACKAGE_TYPES)[number];

/** Whether `extension` is a deck package (a zip, not a .ppt). */
export function isDeckPackageType(
  extension: string,
): extension is DeckPackageType {
  return (DECK_PACKAGE_TYPES as readonly string[]).includes(
    extension.toLowerCase(),
  );
}

/** Content type of `ppt/presentation.xml` for each deck type. */
export const DECK_MAIN_CONTENT_TYPES: Record<DeckPackageType, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
};

/** Largest non-XML part taken from a translation (an embedded workbook). */
const MAX_TAKEN_PART_BYTES = 64 * 1024 * 1024;

const VBA_RELATIONSHIP =
  /<Relationship\b[^>]*Type="[^"]*\/vbaProject"[^>]*\/>/g;

/**
 * Writes the copy of a deck the service is sent.
 *
 * @param sourcePath - The person's deck.
 * @param type - Its type.
 * @param outPath - Where the `.pptx` copy goes.
 */
export async function makeServiceCopy(
  sourcePath: string,
  type: DeckPackageType,
  outPath: string,
): Promise<void> {
  if (type === 'pptx') {
    await fs.promises.copyFile(sourcePath, outPath);
    return;
  }
  const entries = await readPackageDirectory(sourcePath);
  const replacements = new Map<string, Buffer>();
  const removals = new Set<string>();

  const types = await readPackagePart(
    sourcePath,
    entries,
    '[Content_Types].xml',
    MAX_DECK_XML_BYTES,
  );
  if (types) {
    replacements.set(
      '[Content_Types].xml',
      Buffer.from(presentationContentTypes(types.toString('utf8'))),
    );
  }
  const relsName = relsPartOf('ppt/presentation.xml');
  const rels = await readPackagePart(
    sourcePath,
    entries,
    relsName,
    MAX_DECK_XML_BYTES,
  );
  if (rels && rels.toString('utf8').includes('/vbaProject"')) {
    replacements.set(
      relsName,
      Buffer.from(rels.toString('utf8').replace(VBA_RELATIONSHIP, '')),
    );
  }
  for (const entry of entries) {
    if (/^ppt\/vbaProject\.bin$|^ppt\/vbaData\.xml$/i.test(entry.name)) {
      removals.add(entry.name);
    }
  }
  await writePackage(sourcePath, outPath, replacements, removals);
}

/**
 * A package's content types with `ppt/presentation.xml` declared a plain
 * presentation, whatever it was declared before, and without the entry for
 * a macro part.
 */
export function presentationContentTypes(xml: string): string {
  return xml
    .replace(
      /(<Override\b[^>]*PartName="\/ppt\/presentation\.xml"[^>]*ContentType=")[^"]*(")/,
      `$1${DECK_MAIN_CONTENT_TYPES.pptx}$2`,
    )
    .replace(
      /(<Override\b[^>]*ContentType=")[^"]*("[^>]*PartName="\/ppt\/presentation\.xml")/,
      `$1${DECK_MAIN_CONTENT_TYPES.pptx}$2`,
    )
    .replace(/<Override\b[^>]*PartName="\/ppt\/vbaProject\.bin"[^>]*\/>/g, '');
}

/** Whether a translated part is taken into the person's deck. */
export function takesPart(name: string, translateNotes: boolean): boolean {
  if (!name.startsWith('ppt/')) return false; // content types, docProps
  if (name.includes('/_rels/')) return false; // structure stays theirs
  if (/^ppt\/(media|fonts)\//.test(name)) return false;
  if (/vbaProject\.bin$|vbaData\.xml$/i.test(name)) return false;
  if (!translateNotes && name.startsWith('ppt/notesSlides/')) return false;
  return true;
}

/** Whether two parts have the same content, by their directory records. */
function sameContent(a: PackageEntry, b: PackageEntry): boolean {
  return a.crc32 === b.crc32 && a.uncompressedSize === b.uncompressedSize;
}

/** What a merge did, for logs and tests. */
export interface DeckMergeResult {
  /** Parts taken from the translation. */
  taken: string[];
  /** Slides in the merged deck. */
  slides: number;
}

/**
 * Puts a translation's text parts into the person's deck (see THE MERGE
 * CONVENTION).
 *
 * @param basePath - The person's deck (or the `.pptx` made from a `.ppt`).
 * @param translatedPath - What the service returned.
 * @param outPath - Where the merged deck is written.
 * @param translateNotes - Whether translated speaker notes are taken.
 * @throws DeckFormatError / PackageFormatError when either deck cannot be
 *   read, or the merged deck does not have the base's slides.
 */
export async function mergeTranslatedDeck(options: {
  basePath: string;
  translatedPath: string;
  outPath: string;
  translateNotes: boolean;
}): Promise<DeckMergeResult> {
  const { basePath, translatedPath, outPath, translateNotes } = options;
  const base = await readPackageDirectory(basePath);
  const translated = new Map(
    (await readPackageDirectory(translatedPath)).map((entry) => [
      entry.name,
      entry,
    ]),
  );
  const replacements = new Map<string, Buffer>();
  for (const entry of base) {
    const theirs = translated.get(entry.name);
    if (!theirs || sameContent(entry, theirs)) continue;
    if (!takesPart(entry.name, translateNotes)) continue;
    const cap = entry.name.endsWith('.xml')
      ? MAX_DECK_XML_BYTES
      : MAX_TAKEN_PART_BYTES;
    const content = await readPackagePart(
      translatedPath,
      [theirs],
      entry.name,
      cap,
    );
    if (content) replacements.set(entry.name, content);
  }
  await writePackage(basePath, outPath, replacements);

  // The merged deck must read as a deck with every slide of the base.
  const [before, after] = await Promise.all([
    readDeckSlides(basePath),
    readDeckSlides(outPath),
  ]);
  if (before.length !== after.length) {
    await fs.promises.rm(outPath, { force: true });
    throw new Error(
      `The translated deck has ${after.length} slides instead of ${before.length}.`,
    );
  }
  return { taken: [...replacements.keys()], slides: after.length };
}
