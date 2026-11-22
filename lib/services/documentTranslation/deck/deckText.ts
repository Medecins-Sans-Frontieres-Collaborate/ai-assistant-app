/**
 * The slides of a deck and their text, read from its XML (read only).
 *
 * SLIDE NUMBER CONVENTION: slides are numbered from 1 in the order the
 * presentation lists them (`p:sldIdLst` in `ppt/presentation.xml`), hidden
 * slides included. That is the number PowerPoint shows, and the page number
 * of a PDF made with `ExportHiddenSlides` (see the render service). It is not
 * the number in a slide's part name: `slide7.xml` can be the second slide.
 *
 * Text is read with patterns, not a parser: this module never writes XML,
 * and DrawingML text is regular (`a:p` paragraphs of `a:t` runs and `a:br`
 * breaks). Alternate content is read once (its fallback copy is skipped).
 */
import {
  PackageEntry,
  PackageFormatError,
  readPackageDirectory,
  readPackagePart,
} from '@/lib/services/documents/render/ooxmlPackage';

import path from 'path';

/** Largest slide, notes or presentation part read, uncompressed. */
export const MAX_DECK_XML_BYTES = 16 * 1024 * 1024;

/** One slide's text. */
export interface DeckSlide {
  /** 1-based; see SLIDE NUMBER CONVENTION. */
  number: number;
  /** The slide's part name, as `ppt/slides/slide1.xml`. */
  part: string;
  /** Hidden in a slide show (`show="0"`). */
  hidden: boolean;
  /** Paragraphs in document order, one per line; empty paragraphs dropped. */
  text: string;
  /** The speaker notes' text, or '' when there are none. */
  notes: string;
  /** The notes part name, when the slide has one. */
  notesPart?: string;
}

/** Raised for a deck whose structure cannot be read. */
export class DeckFormatError extends Error {
  readonly code = 'DECK_UNREADABLE';
  constructor(message: string) {
    super(message);
    this.name = 'DeckFormatError';
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decodes XML character references and the five named entities. */
export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1].toLowerCase() === 'x'
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

/**
 * The text of a DrawingML part: each paragraph's runs joined, a line break
 * as a newline, paragraphs one per line, empty ones dropped.
 */
export function drawingText(xml: string): string {
  // One copy of alternate content: the choice, never the fallback.
  const once = xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '');
  const paragraphs: string[] = [];
  for (const [, body] of once.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let line = '';
    for (const piece of body.matchAll(
      /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:t(?:\s[^>]*)?\/>|<a:br\b[^>]*\/?>/g,
    )) {
      if (piece[0].startsWith('<a:br')) line += '\n';
      else if (piece[1] !== undefined) line += decodeXmlText(piece[1]);
    }
    if (line.trim()) paragraphs.push(line);
  }
  return paragraphs.join('\n');
}

/** The relationship id to target map of a `.rels` part. */
export function relationshipTargets(
  relsXml: string,
): Map<string, { target: string; type: string }> {
  const targets = new Map<string, { target: string; type: string }>();
  for (const [tag] of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(tag)?.[1];
    const type = /\bType="([^"]*)"/.exec(tag)?.[1] ?? '';
    if (id && target) targets.set(id, { target: decodeXmlText(target), type });
  }
  return targets;
}

/** The `.rels` part that belongs to `part`. */
export function relsPartOf(part: string): string {
  return path.posix.join(
    path.posix.dirname(part),
    '_rels',
    `${path.posix.basename(part)}.rels`,
  );
}

/** A relationship target resolved against the part that names it. */
export function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(fromPart), target),
  );
}

/** Slide part names in presentation order. */
export async function slideParts(
  filePath: string,
  entries: PackageEntry[],
): Promise<string[]> {
  const presentation = await readPackagePart(
    filePath,
    entries,
    'ppt/presentation.xml',
    MAX_DECK_XML_BYTES,
  );
  const rels = await readPackagePart(
    filePath,
    entries,
    'ppt/_rels/presentation.xml.rels',
    MAX_DECK_XML_BYTES,
  );
  if (!presentation || !rels) {
    throw new DeckFormatError('The file is not a PowerPoint presentation.');
  }
  const targets = relationshipTargets(rels.toString('utf8'));
  const list =
    /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(
      presentation.toString('utf8'),
    )?.[1] ?? '';
  const parts: string[] = [];
  for (const [tag] of list.matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const id = /\br:id="([^"]*)"/.exec(tag)?.[1];
    const target = id ? targets.get(id)?.target : undefined;
    if (!target) {
      throw new DeckFormatError('A slide in the presentation cannot be found.');
    }
    parts.push(resolveTarget('ppt/presentation.xml', target));
  }
  return parts;
}

/**
 * Reads every slide of a deck.
 *
 * @param filePath - A .pptx/.pptm/.ppsx/.potx on disk.
 * @returns The slides in presentation order.
 * @throws DeckFormatError when it is not a presentation or a slide is missing.
 * @throws PackageFormatError when the package itself cannot be read.
 */
export async function readDeckSlides(filePath: string): Promise<DeckSlide[]> {
  const entries = await readPackageDirectory(filePath);
  const parts = await slideParts(filePath, entries);
  const slides: DeckSlide[] = [];
  for (const [index, part] of parts.entries()) {
    const xml = await readPackagePart(
      filePath,
      entries,
      part,
      MAX_DECK_XML_BYTES,
    );
    if (!xml) throw new DeckFormatError(`Slide ${index + 1} is missing.`);
    const slideXml = xml.toString('utf8');
    const rels = await readPackagePart(
      filePath,
      entries,
      relsPartOf(part),
      MAX_DECK_XML_BYTES,
    );
    const notesTarget = rels
      ? [...relationshipTargets(rels.toString('utf8')).values()].find((rel) =>
          rel.type.endsWith('/notesSlide'),
        )?.target
      : undefined;
    const notesPart = notesTarget
      ? resolveTarget(part, notesTarget)
      : undefined;
    const notesXml = notesPart
      ? await readPackagePart(filePath, entries, notesPart, MAX_DECK_XML_BYTES)
      : undefined;
    slides.push({
      number: index + 1,
      part,
      hidden: /<p:sld\b[^>]*\sshow="(?:0|false)"/.test(slideXml),
      text: drawingText(slideXml),
      notes: notesXml ? notesText(notesXml.toString('utf8')) : '',
      ...(notesXml && notesPart && { notesPart }),
    });
  }
  return slides;
}

/**
 * The text of a notes page: its notes body only. A notes page also holds
 * a picture of the slide and, sometimes, a slide-number placeholder.
 */
export function notesText(xml: string): string {
  const bodies: string[] = [];
  for (const [shape] of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    // The notes text is the body placeholder (type="body").
    if (/<p:ph\b[^>]*\btype="body"/.test(shape))
      bodies.push(drawingText(shape));
  }
  return bodies.filter(Boolean).join('\n');
}

/** Whether an error is about the deck's own structure or package. */
export function isDeckReadError(error: unknown): boolean {
  return (
    error instanceof DeckFormatError || error instanceof PackageFormatError
  );
}
