/**
 * Leaving slides out of a deck (a person removed pages from the download).
 *
 * Only `ppt/presentation.xml` changes: the slides' entries in the slide
 * list, in custom shows and in sections are removed. Their parts stay in
 * the package, still related, so links from other slides keep resolving;
 * a slide no list names is not shown, rendered or printed.
 */
import {
  readPackageDirectory,
  readPackagePart,
  writePackage,
} from '@/lib/services/presentationRender/ooxmlPackage';

import { DeckFormatError, MAX_DECK_XML_BYTES } from './deckText';

const PRESENTATION = 'ppt/presentation.xml';

/**
 * The presentation part with some slides left out of every list.
 *
 * @param xml - `ppt/presentation.xml`.
 * @param slides - 1-based slide numbers (SLIDE NUMBER CONVENTION) to leave out.
 * @returns The new XML and how many slides remain.
 * @throws DeckFormatError when the slide list cannot be read, or every
 *   slide would be left out.
 */
export function withoutSlides(
  xml: string,
  slides: ReadonlySet<number>,
): { xml: string; remaining: number } {
  const list = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(xml);
  if (!list) throw new DeckFormatError('The presentation lists no slides.');
  const entries = [
    ...list[1].matchAll(/<p:sldId\b[^>]*?(?:\/>|>[\s\S]*?<\/p:sldId>)/g),
  ];
  const dropped = entries.filter((_, index) => slides.has(index + 1));
  if (dropped.length === entries.length) {
    throw new DeckFormatError(
      'At least one slide has to stay in the presentation.',
    );
  }
  const ids = new Set<string>();
  const relIds = new Set<string>();
  for (const [tag] of dropped) {
    const id = /\bid="(\d+)"/.exec(tag)?.[1];
    const relId = /\br:id="([^"]+)"/.exec(tag)?.[1];
    if (id) ids.add(id);
    if (relId) relIds.add(relId);
  }
  let out = xml.replace(list[0], () => {
    let inner = list[1];
    for (const [tag] of dropped) inner = inner.replace(tag, '');
    return list[0].replace(list[1], () => inner);
  });
  // Custom shows name slides by relationship id; sections by slide id.
  out = out.replace(
    /<p:sld\b[^>]*\br:id="([^"]+)"[^>]*\/>/g,
    (tag, relId: string) => (relIds.has(relId) ? '' : tag),
  );
  out = out.replace(
    /<p14:sldId\b[^>]*\bid="(\d+)"[^>]*\/>/g,
    (tag, id: string) => (ids.has(id) ? '' : tag),
  );
  return { xml: out, remaining: entries.length - dropped.length };
}

/**
 * Writes a copy of a deck without some slides.
 *
 * @param sourcePath - The deck.
 * @param outPath - Where the copy goes.
 * @param slides - 1-based slide numbers to leave out; numbers past the
 *   last slide are ignored.
 * @returns How many slides the copy has.
 * @throws DeckFormatError when the presentation cannot be read or no
 *   slide would remain.
 */
export async function omitDeckSlides(
  sourcePath: string,
  outPath: string,
  slides: readonly number[],
): Promise<number> {
  const entries = await readPackageDirectory(sourcePath);
  const presentation = await readPackagePart(
    sourcePath,
    entries,
    PRESENTATION,
    MAX_DECK_XML_BYTES,
  );
  if (!presentation) {
    throw new DeckFormatError('The file is not a PowerPoint presentation.');
  }
  const { xml, remaining } = withoutSlides(
    presentation.toString('utf8'),
    new Set(slides),
  );
  await writePackage(
    sourcePath,
    outPath,
    new Map([[PRESENTATION, Buffer.from(xml, 'utf8')]]),
  );
  return remaining;
}
