/**
 * The deterministic half of a brand review (docs/DOCUMENT_PLATFORM.md,
 * phase F): THE DOCUMENT MODEL's text checked against a brand book for
 * fonts, colours, sizes, terms and declared language. Pure, so the job,
 * its tests and anything else can run it.
 *
 * What is checked:
 *  - Units a reader sees. A deck's layout and master text is skipped: it
 *    is mostly placeholder prompts ("Click to add title") that are never
 *    drawn. Speaker notes are not drawn either, so they are checked for
 *    wording only.
 *  - Each rule only when the book sets it: no fonts, no font findings.
 *  - Formatting as the document DECLARES it. An undeclared colour (null,
 *    the reader's automatic colour) or font is not a finding.
 */
import {
  DocumentModel,
  DocumentUnit,
} from '@/lib/utils/shared/documents/documentModel';

import { BrandBookBody, familiesFor, fontKey } from './brandBook';
import {
  COLOR_MATCH_EPSILON,
  DEFAULT_COLOR_TOLERANCE,
  colorDistance,
  isHexColor,
  normalizeHex,
} from './brandColor';
import { BrandFinding } from './brandFindings';

/**
 * Text measured a hair under the minimum still meets it: an authored
 * 9 pt reads back as 8.9999 from some files.
 */
export const SIZE_EPSILON_PT = 0.05;

/** Unit kinds never drawn as content (see the module comment). */
const UNDRAWN_KINDS = new Set(['layout', 'master']);
const WORDING_ONLY_KINDS = new Set(['notes']);

/** A colour any document may use: the palette and the neutrals. */
interface AllowedColor {
  hex: string;
  tolerance: number;
}

function allowedColors(book: BrandBookBody): AllowedColor[] {
  return [
    ...book.palette.map((color) => ({
      hex: color.hex,
      tolerance: color.tolerance,
    })),
    ...book.neutrals.map((hex) => ({
      hex,
      tolerance: DEFAULT_COLOR_TOLERANCE,
    })),
  ];
}

/**
 * Whether a colour is the book's: within ANY allowed colour's own
 * tolerance (not only the nearest's, which may be the tighter one).
 *
 * @returns Whether it matches, and the allowed colours nearest first.
 */
export function judgeColor(
  hex: string,
  allowed: readonly AllowedColor[],
): { matches: boolean; nearest: string[] } {
  const measured = allowed
    .map((entry) => ({ entry, distance: colorDistance(hex, entry.hex) }))
    .sort((a, b) => a.distance - b.distance);
  return {
    matches: measured.some(
      ({ entry, distance }) =>
        distance <= entry.tolerance + COLOR_MATCH_EPSILON,
    ),
    nearest: [...new Set(measured.map(({ entry }) => entry.hex))],
  };
}

/** Escapes a term for a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A term as a whole word or phrase, in any case, with any spacing
 * between its words: "fund raising" finds "Fund  raising", not
 * "fundraising".
 */
export function termPattern(term: string): RegExp {
  const words = term.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * How often a term occurs in a text, not counting where it is part of one
 * of the phrases written in its place: a book that avoids "homeless" in
 * favour of "people who are homeless" must not report the second, and one
 * that prefers "Médecins Sans Frontières (MSF)" to "MSF" must not report
 * the preferred name itself.
 *
 * @param text - The text searched.
 * @param term - The word or phrase counted.
 * @param accepted - Phrases the book asks for where the term would be.
 */
export function termOccurrences(
  text: string,
  term: string,
  accepted: readonly string[] = [],
): number {
  const spans = accepted
    .filter((phrase) => phrase.trim())
    .flatMap((phrase) =>
      [...text.matchAll(termPattern(phrase))].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
      })),
    );
  return [...text.matchAll(termPattern(term))].filter(
    (match) =>
      !spans.some(
        (span) =>
          match.index >= span.start &&
          match.index + match[0].length <= span.end,
      ),
  ).length;
}

/**
 * Whether a declared language is one of the book's: compared by primary
 * subtag, so a book's `en` takes `en-GB` and a book's `en-GB` takes `en`.
 */
export function languageAllowed(
  tag: string,
  locales: readonly string[],
): boolean {
  const primary = (value: string) => value.toLowerCase().split(/[-_]/)[0];
  return locales.some((locale) => primary(locale) === primary(tag));
}

/** A finding about one unit. */
function unitFinding(
  unit: DocumentUnit,
  values: Pick<BrandFinding, 'rule' | 'severity' | 'found' | 'expected'> &
    Partial<Pick<BrandFinding, 'count'>>,
): BrandFinding {
  return {
    id: `${values.rule}:${unit.id}:${values.found.toLowerCase()}`,
    page: unit.page,
    unitId: unit.id,
    imageId: null,
    box: unit.box,
    source: 'check',
    ...values,
  };
}

/** The visual checks of one drawn unit: fonts, colours, sizes. */
function visualFindings(
  unit: DocumentUnit,
  book: BrandBookBody,
  families: Set<string>,
  colors: AllowedColor[],
): BrandFinding[] {
  const findings = new Map<string, BrandFinding>();
  const add = (finding: BrandFinding) => {
    if (!findings.has(finding.id)) findings.set(finding.id, finding);
  };
  // A family set for two roles is named once.
  const expectedFonts = [...new Set(book.fonts.map((font) => font.family))];
  for (const run of unit.runs) {
    if (!run.text.trim()) continue;
    if (families.size > 0 && run.font && !families.has(fontKey(run.font))) {
      add(
        unitFinding(unit, {
          rule: 'font',
          severity: 'error',
          found: run.font,
          expected: expectedFonts,
        }),
      );
    }
    if (colors.length > 0 && run.color && isHexColor(run.color)) {
      const hex = normalizeHex(run.color);
      const judged = judgeColor(hex, colors);
      if (!judged.matches) {
        add(
          unitFinding(unit, {
            rule: 'color',
            severity: 'error',
            found: hex,
            expected: judged.nearest.slice(0, 3),
          }),
        );
      }
    }
    if (
      book.minTextSizePt > 0 &&
      run.size !== null &&
      run.size < book.minTextSizePt - SIZE_EPSILON_PT
    ) {
      add(
        unitFinding(unit, {
          rule: 'size',
          severity: 'error',
          found: String(Math.round(run.size * 10) / 10),
          expected: [String(book.minTextSizePt)],
        }),
      );
    }
  }
  return [...findings.values()];
}

/** The wording checks of one unit: banned and preferred terms, language. */
function wordingFindings(
  unit: DocumentUnit,
  book: BrandBookBody,
): BrandFinding[] {
  const findings: BrandFinding[] = [];
  // Every phrase the book reports, from either list. Words inside a longer
  // reported phrase are that phrase's finding, not a second one ("the
  // field" inside "in the field"), whichever list each is in.
  const reported = [
    ...book.language.banned.map((entry) => entry.term),
    ...book.language.preferred.flatMap((entry) => entry.alternatives),
  ];
  const longerThan = (term: string) =>
    reported.filter(
      (other) => other.length > term.length && termOccurrences(other, term) > 0,
    );
  for (const banned of book.language.banned) {
    const longer = longerThan(banned.term);
    const count = termOccurrences(unit.text, banned.term, [
      ...banned.alternatives,
      ...longer,
    ]);
    if (count > 0) {
      findings.push(
        unitFinding(unit, {
          rule: 'banned-term',
          severity: 'error',
          found: banned.term,
          expected: banned.alternatives,
          ...(count > 1 ? { count } : {}),
        }),
      );
    }
  }
  // A preferred term lists the words it should be used instead of. A word
  // several preferred terms replace is one finding offering all of them.
  const replacements = new Map<
    string,
    { instead: string; count: number; expected: string[] }
  >();
  for (const preferred of book.language.preferred) {
    for (const instead of preferred.alternatives) {
      const count = termOccurrences(unit.text, instead, [
        preferred.term,
        ...longerThan(instead),
      ]);
      if (count === 0) continue;
      const key = instead.trim().toLowerCase();
      const held = replacements.get(key);
      replacements.set(key, {
        instead: held?.instead ?? instead,
        count: Math.max(held?.count ?? 0, count),
        expected: [...(held?.expected ?? []), preferred.term],
      });
    }
  }
  for (const { instead, count, expected } of replacements.values()) {
    findings.push(
      unitFinding(unit, {
        rule: 'preferred-term',
        severity: 'warning',
        found: instead,
        expected,
        ...(count > 1 ? { count } : {}),
      }),
    );
  }
  if (book.language.locales.length > 0) {
    const declared = new Set(
      unit.runs
        .filter((run) => run.text.trim() && run.lang)
        .map((run) => run.lang as string),
    );
    for (const tag of declared) {
      if (!languageAllowed(tag, book.language.locales)) {
        findings.push(
          unitFinding(unit, {
            rule: 'language',
            severity: 'warning',
            found: tag,
            expected: book.language.locales,
          }),
        );
      }
    }
  }
  return findings;
}

/**
 * Checks a document's text against a brand book.
 *
 * @param model - The document read (THE DOCUMENT MODEL).
 * @param book - The brand book.
 * @returns Findings, one per rule, unit and value (a unit set wholly in
 *   the wrong font is one finding, not one per run).
 */
export function checkDocumentText(
  model: DocumentModel,
  book: BrandBookBody,
): BrandFinding[] {
  const families = familiesFor(book);
  const colors = book.palette.length > 0 ? allowedColors(book) : [];
  const findings: BrandFinding[] = [];
  for (const unit of model.units) {
    if (UNDRAWN_KINDS.has(unit.kind) || !unit.text.trim()) continue;
    if (!WORDING_ONLY_KINDS.has(unit.kind)) {
      findings.push(...visualFindings(unit, book, families, colors));
    }
    findings.push(...wordingFindings(unit, book));
  }
  return findings;
}
