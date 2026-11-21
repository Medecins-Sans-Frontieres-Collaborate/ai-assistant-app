/**
 * A BRAND BOOK: what an organisation's documents must look and sound like,
 * as data a brand review checks against and a deck builder builds from
 * (docs/DOCUMENT_PLATFORM.md, phases E to G).
 *
 * Every bound is deliberate: these values drive hard checks, so a typo
 * must be refused when the book is saved, not discovered in a review.
 * Colours follow THE COLOUR CONVENTION (brandColor.ts); sizes are points.
 */
import {
  DEFAULT_COLOR_TOLERANCE,
  isHexColor,
  normalizeHex,
} from './brandColor';

import { z } from 'zod';

/** Version of this shape; a stored book of another version is not read. */
export const BRAND_BOOK_VERSION = 1;

/** What a colour is for in the brand. */
export const BRAND_COLOR_ROLES = [
  'primary',
  'secondary',
  'accent',
  'text',
  'background',
  'neutral',
] as const;

/** What a typeface is for in the brand. */
export const BRAND_FONT_ROLES = ['heading', 'body', 'accent'] as const;

/** Files a brand book may hold as templates. */
export const BRAND_TEMPLATE_TYPES = ['potx', 'pptx', 'dotx', 'docx'] as const;

/** Files a brand book may hold as logos. */
export const BRAND_LOGO_TYPES = ['png', 'svg', 'jpg', 'jpeg'] as const;

const hexColor = z
  .string()
  .trim()
  .refine(isHexColor, 'must be a #rrggbb colour')
  .transform(normalizeHex);

/** A stored file of the book: an admin reference `admin:<book>/<file>`. */
const fileRef = z.string().trim().min(1).max(300);

export const BrandColorSchema = z.object({
  name: z.string().trim().min(1).max(60),
  hex: hexColor,
  roles: z
    .array(z.enum(BRAND_COLOR_ROLES))
    .max(BRAND_COLOR_ROLES.length)
    .default([]),
  /** CIEDE2000 distance still taken as this colour. */
  tolerance: z.number().min(0).max(20).default(DEFAULT_COLOR_TOLERANCE),
});

export const BrandFontSchema = z.object({
  role: z.enum(BRAND_FONT_ROLES),
  family: z.string().trim().min(1).max(80),
  /** Families accepted in its place (a system font where it is missing). */
  substitutes: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
});

export const BrandLogoSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(80),
  file: fileRef,
  /** Smallest width it may be placed at, in points. */
  minWidthPt: z.number().min(0).max(2000).optional(),
  /** Colours the logo may be shown in (a one-colour version), if limited. */
  allowedColors: z.array(hexColor).max(12).default([]),
  /** Share of its proportions it may be stretched by (0.02 is 2 %). */
  aspectTolerance: z.number().min(0).max(0.5).default(0.02),
});

export const BrandTermSchema = z.object({
  term: z.string().trim().min(1).max(120),
  /** For a preferred term: words to use it instead of. For a banned one:
   * what to write instead. */
  alternatives: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  note: z.string().trim().max(300).default(''),
});

export const BrandLanguageSchema = z.object({
  /** BCP 47 tags documents may be written in; empty for any. */
  locales: z.array(z.string().trim().min(2).max(35)).max(60).default([]),
  preferred: z.array(BrandTermSchema).max(500).default([]),
  banned: z.array(BrandTermSchema).max(500).default([]),
  /** How the brand sounds, in a few sentences, for a reviewing model. */
  tone: z.string().trim().max(2000).default(''),
});

export const BrandTemplateSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(80),
  type: z.enum(BRAND_TEMPLATE_TYPES),
  file: fileRef,
});

/** What a brand book says, as an admin edits it. */
export const BrandBookBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(''),
    palette: z.array(BrandColorSchema).max(60).default([]),
    /** Colours that may appear without being in the palette (white, black). */
    neutrals: z.array(hexColor).max(12).default(['#ffffff', '#000000']),
    fonts: z.array(BrandFontSchema).max(12).default([]),
    /** Smallest text size allowed, in points. */
    minTextSizePt: z.number().min(0).max(72).default(0),
    logos: z.array(BrandLogoSchema).max(20).default([]),
    language: BrandLanguageSchema.default({
      locales: [],
      preferred: [],
      banned: [],
      tone: '',
    }),
    templates: z.array(BrandTemplateSchema).max(20).default([]),
    /** The brand guide this book was written from, if uploaded. */
    source: z
      .object({ file: fileRef, name: z.string().trim().min(1).max(200) })
      .optional(),
  })
  .superRefine((book, context) => {
    const unique = (values: string[], path: string) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        const key = value.toLowerCase();
        if (seen.has(key)) {
          context.addIssue({
            code: 'custom',
            path: [path, index],
            message: `"${value}" appears twice`,
          });
        }
        seen.add(key);
      });
    };
    unique(
      book.palette.map((color) => color.name),
      'palette',
    );
    unique(
      book.logos.map((logo) => logo.id),
      'logos',
    );
    unique(
      book.templates.map((template) => template.id),
      'templates',
    );
    unique(
      book.fonts.map((font) => font.role),
      'fonts',
    );
  });

export type BrandColor = z.infer<typeof BrandColorSchema>;
export type BrandFont = z.infer<typeof BrandFontSchema>;
export type BrandLogo = z.infer<typeof BrandLogoSchema>;
export type BrandTerm = z.infer<typeof BrandTermSchema>;
export type BrandTemplate = z.infer<typeof BrandTemplateSchema>;
export type BrandBookBody = z.infer<typeof BrandBookBodySchema>;

/**
 * Reads a brand book's body as an admin sent it.
 *
 * @returns The body with defaults filled and colours normalised, or the
 *   first problem as `path: message`.
 */
export function parseBrandBookBody(
  input: unknown,
): { ok: true; body: BrandBookBody } | { ok: false; error: string } {
  const parsed = BrandBookBodySchema.safeParse(input);
  if (parsed.success) return { ok: true, body: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: `${issue.path.join('.') || 'body'}: ${issue.message}`,
  };
}

/** Every family a role accepts: its family and its substitutes. */
export function familiesFor(book: Pick<BrandBookBody, 'fonts'>): Set<string> {
  const families = new Set<string>();
  for (const font of book.fonts) {
    families.add(fontKey(font.family));
    for (const substitute of font.substitutes)
      families.add(fontKey(substitute));
  }
  return families;
}

/**
 * A font name compared without case, spacing, or the style a PDF appends
 * (`SourceSansPro-Bold`, `Source Sans Pro Semibold`).
 */
export function fontKey(name: string): string {
  return name
    .replace(
      /[-,](bold|italic|oblique|regular|semibold|light|medium|black|condensed|mt|ps).*$/i,
      '',
    )
    .replace(
      /\s+(bold|italic|oblique|regular|semibold|light|medium|black)(\s.*)?$/i,
      '',
    )
    .replace(/[\s_-]+/g, '')
    .toLowerCase();
}

/**
 * An id for a new logo or template, made from its name and unique among
 * the ids already taken (the schema's `^[a-z0-9-]{1,40}$`).
 *
 * @example brandItemId('Main logo', ['main-logo']) === 'main-logo-2'
 */
export function brandItemId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'item';
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * The template type a file name stands for, or null for a file no
 * template can be.
 */
export function templateTypeForFile(
  fileName: string,
): (typeof BRAND_TEMPLATE_TYPES)[number] | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? '';
  return (BRAND_TEMPLATE_TYPES as readonly string[]).includes(ext)
    ? (ext as (typeof BRAND_TEMPLATE_TYPES)[number])
    : null;
}
