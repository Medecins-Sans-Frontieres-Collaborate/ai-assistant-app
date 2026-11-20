/**
 * The model's half of a brand review (docs/DOCUMENT_PLATFORM.md, phase F):
 * one call per page, looking at the page's picture with its text units and
 * unplaced pictures named by id, against the book's tone and visual rules.
 *
 * The model reports only what the deterministic checks cannot see: tone,
 * the visual use of colour and imagery, pictures that look like the logo
 * but were not matched, and the language of text that declares none. Its
 * findings are kept only when they point at a unit or picture that is on
 * the page, or at the page as a whole.
 */
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import { BrandBookBody } from '@/lib/utils/shared/brand/brandBook';
import {
  BRAND_FINDING_SEVERITIES,
  BrandFinding,
  BrandFindingRule,
} from '@/lib/utils/shared/brand/brandFindings';
import {
  DocumentImage,
  DocumentUnit,
} from '@/lib/utils/shared/documents/documentModel';

/** The rules the model may report. */
export const MODEL_REVIEW_RULES = [
  'tone',
  'visual',
  'logo-unknown',
  'language',
] as const satisfies readonly BrandFindingRule[];

/** Most findings kept per page. */
const MAX_PAGE_FINDINGS = 12;
/** Most characters of one unit's text sent. */
const MAX_UNIT_CHARS = 600;

interface RawPageFinding {
  rule: (typeof MODEL_REVIEW_RULES)[number];
  severity: (typeof BRAND_FINDING_SEVERITIES)[number];
  unitId: string;
  imageId: string;
  found: string;
  note: string;
}

const PAGE_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule', 'severity', 'unitId', 'imageId', 'found', 'note'],
        properties: {
          rule: { type: 'string', enum: [...MODEL_REVIEW_RULES] },
          severity: { type: 'string', enum: [...BRAND_FINDING_SEVERITIES] },
          unitId: { type: 'string' },
          imageId: { type: 'string' },
          found: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You review one page of a document against an organisation's brand book and report where the page departs from it.

Fonts, text colours, text sizes, banned and preferred words, and declared languages are already checked by software: do not report those.
Report only:
- tone: text whose voice clearly departs from the book's tone. Tie it to the unit (unitId) and quote the words in "found".
- visual: shapes, backgrounds, charts or imagery in colours outside the brand palette and neutrals, or a page whose look plainly ignores the brand. Tie it to a picture (imageId) when it is one, else leave both ids empty for the whole page; "found" names the colour or element.
- logo-unknown: a listed picture that looks like the brand's logo, or an altered, recoloured or old version of it, or a different organisation's mark placed as if it were the brand's. Tie it to the picture (imageId); "found" says what it looks like.
- language: text in a language other than the book's languages. Tie it to the unit; "found" is the language as a BCP 47 tag.

Severity: error for a clear break of a stated rule, warning when likely wrong, info when worth a look. Report nothing that is fine; an empty list is a good answer. "note" is one sentence for the author, in the language of the document, saying what to change. Use only ids from the lists given.`;

/** The book as the model reads it: what it states, plainly. */
export function describeBook(book: BrandBookBody): string {
  const lines = [`Brand book: ${book.name}`];
  if (book.description) lines.push(book.description);
  if (book.palette.length > 0) {
    lines.push(
      `Palette: ${book.palette
        .map(
          (color) =>
            `${color.name} ${color.hex}${color.roles.length ? ` (${color.roles.join(', ')})` : ''}`,
        )
        .join('; ')}`,
    );
  }
  if (book.neutrals.length > 0) {
    lines.push(`Neutrals: ${book.neutrals.join(', ')}`);
  }
  if (book.fonts.length > 0) {
    lines.push(
      `Typefaces: ${book.fonts.map((font) => `${font.role} ${font.family}`).join('; ')}`,
    );
  }
  if (book.logos.length > 0) {
    lines.push(
      `Logos: ${book.logos.map((logo) => logo.name).join('; ')} (pictures attached)`,
    );
  }
  if (book.language.locales.length > 0) {
    lines.push(`Languages: ${book.language.locales.join(', ')}`);
  }
  if (book.language.tone) lines.push(`Tone: ${book.language.tone}`);
  return lines.join('\n');
}

/** The page's units and unplaced pictures, as the model reads them. */
export function describePage(
  units: readonly DocumentUnit[],
  pictures: readonly DocumentImage[],
): string {
  const lines = ['Text units on this page:'];
  for (const unit of units) {
    const text = unit.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(
      `- ${unit.id}: ${text.length > MAX_UNIT_CHARS ? `${text.slice(0, MAX_UNIT_CHARS)}...` : text}`,
    );
  }
  if (lines.length === 1) lines.push('(none)');
  lines.push('', 'Pictures on this page that matched none of the logos:');
  for (const picture of pictures) {
    const where = picture.box
      ? ` at x ${Math.round(picture.box[0])}-${Math.round(picture.box[2])} pt, y ${Math.round(picture.box[1])}-${Math.round(picture.box[3])} pt`
      : '';
    lines.push(
      `- ${picture.id}${where}${picture.name ? ` (${picture.name})` : ''}`,
    );
  }
  if (pictures.length === 0) lines.push('(none)');
  return lines.join('\n');
}

/**
 * Keeps what the model said that points at something on the page, as
 * findings.
 *
 * @param page - The page reviewed.
 * @param raw - The model's answer.
 * @param units - The page's units, by id.
 * @param pictures - The page's unplaced pictures, by id.
 */
export function pageFindings(
  page: number,
  raw: readonly RawPageFinding[],
  units: ReadonlyMap<string, DocumentUnit>,
  pictures: ReadonlyMap<string, DocumentImage>,
): BrandFinding[] {
  const findings: BrandFinding[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const note = item.note.trim();
    if (!note) continue;
    const unit = units.get(item.unitId.trim()) ?? null;
    const picture = unit ? null : (pictures.get(item.imageId.trim()) ?? null);
    // A finding naming an id that is not on the page is dropped, not
    // moved to the whole page: the model was wrong about where.
    if (!unit && !picture && (item.unitId.trim() || item.imageId.trim())) {
      continue;
    }
    const target = unit?.id ?? picture?.id ?? `page${index}`;
    const id = `${item.rule}:${page}:${target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    findings.push({
      id,
      rule: item.rule,
      severity: item.severity,
      page,
      unitId: unit?.id ?? null,
      imageId: picture?.id ?? null,
      box: unit?.box ?? picture?.box ?? null,
      found: item.found.trim().slice(0, 200),
      expected: [],
      source: 'model',
      note: note.slice(0, 500),
    });
    if (findings.length >= MAX_PAGE_FINDINGS) break;
  }
  return findings;
}

/**
 * Reviews one page with a model.
 *
 * @param input.picture - The page as a PNG.
 * @param input.logos - The book's logos as PNG data URLs (a few).
 * @returns The page's model findings.
 */
export async function reviewPage(input: {
  page: number;
  picture: Uint8Array;
  units: readonly DocumentUnit[];
  pictures: readonly DocumentImage[];
  book: BrandBookBody;
  logos: readonly string[];
  model: string;
  usage: WorkflowUsageCollector;
}): Promise<BrandFinding[]> {
  const raw = await callStructured<{ findings: RawPageFinding[] }>({
    client: createAzureClient(),
    model: input.model,
    system: SYSTEM_PROMPT,
    user: [
      {
        type: 'text',
        text: `${describeBook(input.book)}\n\nPage ${input.page}.\n${describePage(input.units, input.pictures)}`,
      },
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${Buffer.from(input.picture).toString('base64')}`,
          detail: 'high',
        },
      },
      ...input.logos.map((url) => ({
        type: 'image_url' as const,
        image_url: { url, detail: 'low' as const },
      })),
    ],
    schemaName: 'brand_page_review',
    schema: PAGE_REVIEW_SCHEMA as unknown as Record<string, unknown>,
    usage: input.usage,
    usageLabel: 'brand-page-review',
  });
  return pageFindings(
    input.page,
    raw.findings ?? [],
    new Map(input.units.map((unit) => [unit.id, unit])),
    new Map(input.pictures.map((picture) => [picture.id, picture])),
  );
}
