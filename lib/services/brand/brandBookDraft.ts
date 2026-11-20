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
  fontKey,
  parseBrandBookBody,
} from '@/lib/utils/shared/brand/brandBook';
import { isHexColor, normalizeHex } from '@/lib/utils/shared/brand/brandColor';
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
- fonts: the typeface for headings, for body text and for accents, as the guide names them, with the substitutes it allows (for example a system font for documents shared outside). Leave a role out when the guide does not set it.
- minTextSizePt: the smallest text size the guide allows, in points; 0 when it sets none.
- locales: the languages the guide says documents are written in, as BCP 47 tags; empty when it does not say.
- preferred: words or names the guide asks to use, each with the words it should be used instead of.
- banned: words the guide asks to avoid, each with what to write instead and a short reason when it gives one.
- tone: the guide's voice in at most five sentences, in its own terms.

The measured fonts and colours of the guide's text are evidence of what the guide uses; prefer the guide's stated values, and use the measurements to confirm a value or read one the text does not spell out.`;

/**
 * Keeps what can be a brand book of the model's answer: valid colours,
 * one font per role, sizes in range. Anything it cannot use is dropped
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
  // One font per role: the first the model gives.
  const seenRoles = new Set<string>();
  const fonts: Array<{ role: string; family: string; substitutes: string[] }> =
    [];
  for (const font of raw.fonts) {
    if (!font.family.trim() || seenRoles.has(font.role)) continue;
    seenRoles.add(font.role);
    fonts.push({
      role: font.role,
      family: font.family.trim().slice(0, 80),
      substitutes: font.substitutes
        .map((substitute) => substitute.trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 10),
    });
  }
  const terms = <T extends { term: string }>(list: T[]) =>
    list.filter((entry) => entry.term.trim()).slice(0, 500);
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
        alternatives: entry.alternatives.filter(Boolean).slice(0, 10),
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

/**
 * Drafts a brand book from a guide.
 *
 * @param guide - The guide's PDF.
 * @param source - The guide's upload reference and file name, kept as
 *   the book's source.
 * @returns The draft (not stored) and what was measured.
 * @throws DocumentRefusedError when the PDF cannot be read; Error when the
 *   model's answer cannot be made into a book.
 */
export async function draftBrandBook(input: {
  guide: Buffer;
  source: { file: string; name: string };
  usage: WorkflowUsageCollector;
  model: string;
  signal?: AbortSignal;
}): Promise<{ book: BrandBookBody; evidence: GuideEvidence }> {
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
    const parsed = parseBrandBookBody({
      ...(cleanDraft(raw) as object),
      source: input.source,
    });
    if (!parsed.ok) {
      throw new Error(
        `The guide could not be made into a brand book: ${parsed.error}`,
      );
    }
    return { book: parsed.body, evidence };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}
