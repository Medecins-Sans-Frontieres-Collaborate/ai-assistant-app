/**
 * A draft brand book from a brand guide PDF (docs/DOCUMENT_PLATFORM.md,
 * phase E): what the guide's pages show (THE DOCUMENT MODEL: the fonts and
 * colours its text is set in, weighted by how much text uses them) and
 * what its text says, turned by a model into a book an admin then checks
 * and saves. Nothing is stored here.
 *
 * Logos are not taken from the guide: a guide shows each logo many times,
 * on many backgrounds and often cropped, so the admin uploads the files.
 */
import { inspectDocument } from '@/lib/services/documents/model/inspect';
import { truncateToTokenBudget } from '@/lib/services/workflows/shared/textBudget';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import {
  BRAND_COLOR_ROLES,
  BRAND_FONT_ROLES,
  BrandBookBody,
  BrandBookBodySchema,
  fontKey,
} from '@/lib/utils/shared/brand/brandBook';
import { isHexColor, normalizeHex } from '@/lib/utils/shared/brand/brandColor';
import {
  DraftGrounding,
  GuidePageText,
  groundDraft,
} from '@/lib/utils/shared/brand/draftGrounding';
import { DocumentModel } from '@/lib/utils/shared/documents/documentModel';

import fs from 'fs';
import os from 'os';
import path from 'path';

/** Most of the guide's text the model reads. */
const GUIDE_TEXT_TOKENS = 40_000;
/** Most fonts and colours listed as evidence. */
const EVIDENCE_LIMIT = 12;

/** What the guide's pages show, measured. */
export interface GuideEvidence {
  /** Fonts by share of the guide's characters, largest first. */
  fonts: Array<{ family: string; share: number }>;
  /** Text colours by share of the guide's characters, largest first. */
  colors: Array<{ hex: string; share: number }>;
  /** The smallest size a fair amount of text is set in, in points. */
  smallestTextPt: number | null;
  pageCount: number;
}

/**
 * Measures a guide: which fonts and colours its text uses, and how much.
 * A style suffix (Bold, Light) counts toward its family.
 *
 * @param model - The guide read into THE DOCUMENT MODEL.
 */
export function guideEvidence(model: DocumentModel): GuideEvidence {
  const fonts = new Map<string, { family: string; chars: number }>();
  const colors = new Map<string, number>();
  const sizes: Array<{ size: number; chars: number }> = [];
  let total = 0;
  for (const unit of model.units) {
    for (const run of unit.runs) {
      const chars = run.text.replace(/\s+/g, '').length;
      if (chars === 0) continue;
      total += chars;
      if (run.font) {
        const key = fontKey(run.font);
        const held = fonts.get(key);
        // The shortest spelling names the family (no style suffix).
        const family =
          held && held.family.length <= run.font.length
            ? held.family
            : run.font;
        fonts.set(key, { family, chars: (held?.chars ?? 0) + chars });
      }
      if (run.color && isHexColor(run.color)) {
        const hex = normalizeHex(run.color);
        colors.set(hex, (colors.get(hex) ?? 0) + chars);
      }
      if (run.size) sizes.push({ size: run.size, chars });
    }
  }
  const share = (chars: number) =>
    total > 0 ? Math.round((chars / total) * 1000) / 1000 : 0;
  // The smallest size at least 2 % of the text is set in: a footnote
  // counts, a stray glyph does not.
  const bySize = new Map<number, number>();
  for (const { size, chars } of sizes) {
    const rounded = Math.round(size * 2) / 2;
    bySize.set(rounded, (bySize.get(rounded) ?? 0) + chars);
  }
  const smallest = [...bySize.entries()]
    .filter(([, chars]) => total > 0 && chars / total >= 0.02)
    .map(([size]) => size)
    .sort((a, b) => a - b)[0];
  return {
    fonts: [...fonts.values()]
      .sort((a, b) => b.chars - a.chars)
      .slice(0, EVIDENCE_LIMIT)
      .map(({ family, chars }) => ({ family, share: share(chars) })),
    colors: [...colors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, EVIDENCE_LIMIT)
      .map(([hex, chars]) => ({ hex, share: share(chars) })),
    smallestTextPt: smallest ?? null,
    pageCount: model.pageCount,
  };
}

/** The answer the model gives (strict JSON schema below). */
interface RawDraft {
  name: string;
  description: string;
  palette: Array<{ name: string; hex: string; roles: string[] }>;
  neutrals: string[];
  fonts: Array<{ role: string; family: string; substitutes: string[] }>;
  minTextSizePt: number;
  logoMinWidthPt: number;
  locales: string[];
  preferred: Array<{ term: string; alternatives: string[] }>;
  banned: Array<{ term: string; alternatives: string[]; note: string }>;
  tone: string;
}

const stringArray = { type: 'array', items: { type: 'string' } };

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'description',
    'palette',
    'neutrals',
    'fonts',
    'minTextSizePt',
    'logoMinWidthPt',
    'locales',
    'preferred',
    'banned',
    'tone',
  ],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    palette: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'hex', 'roles'],
        properties: {
          name: { type: 'string' },
          hex: { type: 'string' },
          roles: {
            type: 'array',
            items: { type: 'string', enum: [...BRAND_COLOR_ROLES] },
          },
        },
      },
    },
    neutrals: stringArray,
    fonts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'family', 'substitutes'],
        properties: {
          role: { type: 'string', enum: [...BRAND_FONT_ROLES] },
          family: { type: 'string' },
          substitutes: stringArray,
        },
      },
    },
    minTextSizePt: { type: 'number' },
    logoMinWidthPt: { type: 'number' },
    locales: stringArray,
    preferred: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'alternatives'],
        properties: { term: { type: 'string' }, alternatives: stringArray },
      },
    },
    banned: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'alternatives', 'note'],
        properties: {
          term: { type: 'string' },
          alternatives: stringArray,
          note: { type: 'string' },
        },
      },
    },
    tone: { type: 'string' },
  },
} as const;

const SYSTEM_PROMPT = `You turn an organisation's brand guide into a brand book: structured data that documents will be checked against.

Use only what the guide states or plainly shows. Do not invent colours, fonts or rules.
- palette: every brand colour the guide defines, with the name the guide gives it and its hex value. When the guide gives only RGB or CMYK, convert to hex. Give roles only where the guide says what a colour is for (primary, secondary, accent, text, background, neutral).
- neutrals: colours any document may use without being brand colours (usually white and black), as hex.
- fonts: every typeface the guide lets documents use, as the guide names the family (without a weight such as Bold), each with the role it is used for: heading, body, or accent for display, numerals, callouts and handwriting. A role may have several typefaces: give each its own entry. Substitutes are the families the guide allows in a typeface's place (for example the version of it that ships with office software, or a system font for documents shared outside).
- minTextSizePt: the smallest text size the guide allows, in points; 0 when it sets none.
- locales: the languages the guide says documents are written in, as BCP 47 tags; empty when it does not say.
- logoMinWidthPt: the smallest width the guide allows the logo at, in points (1 inch is 72 points); 0 when it sets none.
- preferred: words, names or spellings the guide asks for, each with the words it says NOT to write in its place. A short form or acronym the guide itself uses or allows is not one of those; when the guide names nothing to replace, give no alternatives.
- banned: words or phrases the guide asks to avoid, each with what to write instead and a short reason when it gives one. Give the phrase as it would appear in a document, not a description of it. Do not also list a banned phrase under preferred.
- tone: the guide's voice in at most five sentences, in its own terms.

The measured fonts and colours of the guide's text are evidence of what the guide uses; prefer the guide's stated values, and use the measurements to confirm a value or read one the text does not spell out.`;

/** A term compared without case or surrounding space. */
function termKey(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * Keeps what can be a brand book of the model's answer: valid colours,
 * each typeface once per role, sizes in range. Anything it cannot use is dropped
 * rather than failing the draft; the admin checks the result anyway.
 */
export function cleanDraft(raw: RawDraft): unknown {
  const seenColors = new Set<string>();
  const palette = raw.palette
    .filter((color) => color.name.trim() && isHexColor(color.hex))
    .map((color) => ({
      name: color.name.trim().slice(0, 60),
      hex: normalizeHex(color.hex),
      roles: [...new Set(color.roles)].filter((role) =>
        (BRAND_COLOR_ROLES as readonly string[]).includes(role),
      ),
    }))
    .filter((color) => {
      const key = color.name.toLowerCase();
      if (seenColors.has(key)) return false;
      seenColors.add(key);
      return true;
    })
    .slice(0, 60);
  // A typeface once per role; a role may have several.
  const seenFonts = new Set<string>();
  const fonts: Array<{ role: string; family: string; substitutes: string[] }> =
    [];
  for (const font of raw.fonts) {
    const family = font.family.trim().slice(0, 80);
    const key = `${font.role} ${fontKey(family)}`;
    if (!family || seenFonts.has(key)) continue;
    seenFonts.add(key);
    fonts.push({
      role: font.role,
      family,
      substitutes: font.substitutes
        .map((substitute) => substitute.trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 10),
    });
  }
  const terms = <T extends { term: string }>(list: T[]) =>
    list.filter((entry) => entry.term.trim()).slice(0, 500);
  // A word the guide asks for, or one it bans outright, is not listed again
  // as a word some preferred term replaces: it would be reported twice, or
  // reported although the guide accepts it.
  const settledTerms = new Set(
    [...raw.preferred, ...raw.banned].map((entry) => termKey(entry.term)),
  );
  return {
    name: raw.name.trim().slice(0, 100) || 'Brand book',
    description: raw.description.trim().slice(0, 1000),
    palette,
    neutrals: raw.neutrals.filter(isHexColor).map(normalizeHex).slice(0, 12),
    fonts,
    minTextSizePt: Math.min(72, Math.max(0, raw.minTextSizePt || 0)),
    language: {
      locales: raw.locales.map((l) => l.trim()).filter((l) => l.length >= 2),
      preferred: terms(raw.preferred).map((entry) => ({
        term: entry.term.trim().slice(0, 120),
        alternatives: entry.alternatives
          .filter((word) => word.trim() && !settledTerms.has(termKey(word)))
          .slice(0, 10),
      })),
      banned: terms(raw.banned).map((entry) => ({
        term: entry.term.trim().slice(0, 120),
        alternatives: entry.alternatives.filter(Boolean).slice(0, 10),
        note: entry.note.trim().slice(0, 300),
      })),
      tone: raw.tone.trim().slice(0, 2000),
    },
  };
}

/** What drafting a book from a guide gives. */
export interface BrandBookDraftResult {
  /** The draft; not stored. */
  book: BrandBookBody;
  /** What the guide's pages were measured to use. */
  evidence: GuideEvidence;
  /** Where the guide's text states each drafted value (draftGrounding.ts). */
  grounding: DraftGrounding;
  /** The smallest logo width the guide sets, in points; 0 when none. */
  logoMinWidthPt: number;
  /** Entries of the model's answer dropped as unusable. */
  dropped: number;
}

/**
 * A guide's text page by page, in page order, for looking drafted values
 * up in.
 */
export function guidePages(model: DocumentModel): GuidePageText[] {
  const pages = new Map<number, string[]>();
  for (const unit of model.units) {
    if (unit.page === null) continue;
    pages.set(unit.page, [...(pages.get(unit.page) ?? []), unit.text]);
  }
  return [...pages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, texts]) => ({ page, text: texts.join('\n') }));
}

/** Most entries dropped from one draft before it is given up on. */
const MAX_DROPPED_ENTRIES = 50;

/**
 * Makes a cleaned draft into a brand book, dropping the list entries the
 * book's schema refuses (a "word" that is a whole sentence, a locale that
 * is not a tag) rather than losing the whole draft to one of them: the
 * admin checks the result either way.
 *
 * @param draft - The cleaned draft, with its source.
 * @returns The book and how many entries were dropped.
 * @throws Error when the problem is not in a list entry (nothing to drop)
 *   or more than {@link MAX_DROPPED_ENTRIES} entries are refused.
 */
export function settleDraft(draft: unknown): {
  book: BrandBookBody;
  dropped: number;
} {
  const working = structuredClone(draft);
  for (let dropped = 0; dropped <= MAX_DROPPED_ENTRIES; dropped += 1) {
    const parsed = BrandBookBodySchema.safeParse(working);
    if (parsed.success) return { book: parsed.data, dropped };
    const issue = parsed.error.issues[0];
    if (!dropEntryAt(working, issue.path)) {
      throw new Error(
        `The guide could not be made into a brand book: ${issue.path.join('.') || 'body'}: ${issue.message}`,
      );
    }
  }
  throw new Error(
    'The guide could not be made into a brand book: too much of the draft was unusable.',
  );
}

/**
 * Removes the list entry a schema issue points into: the entry of the
 * DEEPEST list on the path, so a bad alternative costs that alternative,
 * not its term.
 *
 * @returns Whether an entry was removed.
 */
function dropEntryAt(
  root: unknown,
  issuePath: readonly PropertyKey[],
): boolean {
  let holder: unknown = root;
  let list: unknown[] | null = null;
  let index = -1;
  for (const key of issuePath) {
    if (Array.isArray(holder) && typeof key === 'number') {
      list = holder;
      index = key;
    }
    if (holder === null || typeof holder !== 'object') break;
    holder = (holder as Record<PropertyKey, unknown>)[key];
  }
  if (!list || index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  return true;
}

/**
 * Drafts a brand book from a guide.
 *
 * @param guide - The guide's PDF.
 * @param source - The guide's upload reference and file name, kept as
 *   the book's source.
 * @returns The draft and what backs it; see {@link BrandBookDraftResult}.
 * @throws DocumentRefusedError when the PDF cannot be read; Error when the
 *   model's answer cannot be made into a book.
 */
export async function draftBrandBook(input: {
  guide: Buffer;
  source: { file: string; name: string };
  usage: WorkflowUsageCollector;
  model: string;
  signal?: AbortSignal;
}): Promise<BrandBookDraftResult> {
  const started = Date.now();
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'brand-draft-'),
  );
  try {
    const { model } = await inspectDocument(input.guide, 'pdf', {
      lane: 'interactive',
      workDir,
      usage: input.usage,
      signal: input.signal,
    });
    const readDone = Date.now();
    const evidence = guideEvidence(model);
    const text = model.units.map((unit) => unit.text).join('\n');
    const budgeted = await truncateToTokenBudget(text, GUIDE_TEXT_TOKENS);
    const raw = await callStructured<RawDraft>({
      client: createAzureClient(),
      model: input.model,
      system: SYSTEM_PROMPT,
      user: [
        `Measured from the guide's ${evidence.pageCount} pages:`,
        `Fonts (share of text): ${evidence.fonts.map((f) => `${f.family} ${Math.round(f.share * 100)}%`).join(', ') || 'none'}`,
        `Text colours (share of text): ${evidence.colors.map((c) => `${c.hex} ${Math.round(c.share * 100)}%`).join(', ') || 'none'}`,
        `Smallest text in use: ${evidence.smallestTextPt ?? 'unknown'} pt`,
        '',
        'The guide:',
        budgeted.text,
      ].join('\n'),
      schemaName: 'brand_book_draft',
      schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
      usage: input.usage,
      usageLabel: 'brand-book-draft',
    });
    const modelDone = Date.now();
    const settled = settleDraft({
      ...(cleanDraft(raw) as object),
      source: input.source,
    });
    console.info(
      `[brandDraft] ${evidence.pageCount} pages read in ${Math.round((readDone - started) / 1000)}s, drafted in ${Math.round((modelDone - readDone) / 1000)}s, ${settled.dropped} entries dropped`,
    );
    return {
      book: settled.book,
      evidence,
      grounding: groundDraft(settled.book, guidePages(model)),
      logoMinWidthPt: Math.min(
        2000,
        Math.max(0, Math.round(raw.logoMinWidthPt || 0)),
      ),
      dropped: settled.dropped,
    };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}
