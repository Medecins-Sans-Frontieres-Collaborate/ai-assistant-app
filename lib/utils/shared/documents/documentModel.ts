/**
 * THE DOCUMENT MODEL: what any feature reads about a document, the same
 * for every format (docs/DOCUMENT_PLATFORM.md). The format readers
 * (lib/services/documents/model) produce it; brand review, previews and
 * other features consume it.
 *
 *  - PAGES are numbered as THE DOCUMENT SOURCE's PDF numbers them: page n
 *    of a presentation is slide n (hidden slides included).
 *  - COORDINATES are points from a page's top-left corner (pageGeometry.ts).
 *  - A UNIT is one paragraph (a text block in a PDF). Its runs carry the
 *    formatting as the document DECLARES it, inherited through styles,
 *    layouts, masters and the theme. A PDF declares only what it draws.
 *  - IDS are stable for an unchanged file and change meaning only with
 *    `scheme`: anything stored against unit or picture ids (findings,
 *    edits) records the scheme it was made with.
 */

/** Version of the id scheme and of this shape. */
export const DOCUMENT_MODEL_SCHEME = 1;

/** `[x0, y0, x1, y1]` in page points. */
export type PageBox = [number, number, number, number];

/** A stretch of text with one formatting. */
export interface DocumentRun {
  text: string;
  /** The typeface as declared (a PDF's as embedded, without subset prefix). */
  font: string | null;
  /** Points. */
  size: number | null;
  /** `#rrggbb`, or null when inherited from the reader (automatic). */
  color: string | null;
  bold: boolean;
  italic: boolean;
  /** A BCP 47 tag as declared, or null. */
  lang: string | null;
}

/** One paragraph. */
export interface DocumentUnit {
  id: string;
  /** Null until placed (a Word document's units, see placeUnits). */
  page: number | null;
  /**
   * Where it sits in the document: a deck's 'slide', 'layout', 'master',
   * 'notes', 'table', 'chart' or 'value'; a Word document's 'body',
   * 'table', 'header' or 'footer'; a PDF's 'text'.
   */
  kind: string;
  /** Its text, plain. */
  text: string;
  /** Where its text is drawn; null for text not drawn on a page (notes). */
  box: PageBox | null;
  runs: DocumentRun[];
}

/** A picture placed on a page. */
export interface DocumentImage {
  id: string;
  page: number | null;
  box: PageBox | null;
  /** Its name or description in the document, when it has one. */
  name: string | null;
  /** Of its bytes: the same picture placed twice has one hash. */
  sha256: string;
  /** Its bytes in the reader's archive (InspectedDocument.imageFile). */
  file: string;
  contentType: string;
  /** Drawn by a deck's layout or master rather than the page itself. */
  inherited?: 'layout' | 'master' | null;
}

/** The colours and fonts a document's theme declares (OOXML). */
export interface DocumentTheme {
  /** Scheme name (dk1, lt1, accent1...) to `#rrggbb`. */
  colors: Record<string, string>;
  fonts: { major: string | null; minor: string | null };
}

export interface DocumentPageInfo {
  page: number;
  width: number;
  height: number;
  hidden?: boolean;
}

/** A document described (THE DOCUMENT MODEL). */
export interface DocumentModel {
  scheme: number;
  /** The format it was read as: 'pptx', 'docx' or 'pdf'. */
  format: string;
  pageCount: number;
  pages: DocumentPageInfo[];
  units: DocumentUnit[];
  images: DocumentImage[];
  theme: DocumentTheme | null;
}

/** Text compared without case, spacing or punctuation differences. */
export function comparableText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[•▪●–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Characters of a paragraph's start that must match where it is placed. */
const PLACE_PREFIX_CHARS = 24;

function unionBox(a: PageBox, b: PageBox): PageBox {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/**
 * Places units read from a document's file (a Word document's paragraphs,
 * which have no pages) on the pages of its PDF rendering: each unit takes
 * the page and box of the rendered text that starts the same way, searched
 * in reading order from the last one placed, and grows over the blocks
 * that continue it on that page. A unit not found stays unplaced.
 *
 * @param units - Units in reading order, without pages.
 * @param rendered - The rendering's units (a PDF model's), in page order.
 * @returns The units with page and box where found.
 */
export function placeUnits(
  units: DocumentUnit[],
  rendered: DocumentUnit[],
): DocumentUnit[] {
  const targets = rendered.map((unit) => ({
    unit,
    text: comparableText(unit.text),
  }));
  let from = 0;
  return units.map((unit) => {
    const text = comparableText(unit.text);
    if (!text) return unit;
    const prefix = text.slice(0, PLACE_PREFIX_CHARS);
    const at = targets.findIndex(
      (target, index) =>
        index >= from &&
        target.text.length > 0 &&
        (target.text.startsWith(prefix) || text.startsWith(target.text)),
    );
    if (at < 0) return unit;
    const first = targets[at].unit;
    let box = first.box;
    let next = at + 1;
    // A paragraph broken over several blocks on its page.
    while (
      box &&
      next < targets.length &&
      targets[next].unit.page === first.page &&
      targets[next].unit.box &&
      targets[next].text.length > 0 &&
      text.includes(targets[next].text) &&
      !targets[next].text.startsWith(prefix)
    ) {
      box = unionBox(box, targets[next].unit.box as PageBox);
      next += 1;
    }
    from = next;
    return { ...unit, page: first.page, box };
  });
}
