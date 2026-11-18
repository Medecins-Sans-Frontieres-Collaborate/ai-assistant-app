import {
  NATIVE_PDF_ISSUE_KINDS,
  NATIVE_PDF_ROLES,
  NativePdfInstructableStep,
  NativePdfStepInstructions,
} from '@/lib/utils/shared/translation/nativePdf';

/**
 * The fixed prompts and output schemas of the native PDF pipeline's model
 * steps. Each prompt is a set of rules followed by an optional block of
 * caller-supplied instructions, which are framed as additions and can never
 * replace the rules above them.
 */

const FIXED_PROMPTS: Record<NativePdfInstructableStep, string> = {
  analyze: [
    'You are preparing one page of a PDF for translation. The image shows the page with every text unit outlined and numbered; the list gives each numbered unit its text.',
    'For every unit in the list, decide:',
    '- role: what the unit is on the page.',
    '- translate: false only when the ENTIRE unit is a proper name or identifier that is written the same way in every language: names of people, companies, organisations, mines or projects, product names, codes, URLs, reference numbers. Otherwise true.',
    '  Always true for: country and region names (they have translations), dates and month names, column headers, labels, running headers and footers, and any unit that mixes a name with ordinary words or abbreviations (for example "JV (Company A and Company B)").',
    '  When unsure, choose true: the translator keeps names intact inside a translated unit.',
    '- note: at most 12 words of context a translator needs (for example "column header of a table of mines", "company name, keep"), or an empty string.',
    'Also give pageNotes: one or two sentences on what the page is and anything that affects translation (tables, repeated headers, text inside images that cannot be changed).',
    'Judge from the image and the text together. Return every unit number from the list exactly once and no others.',
  ].join('\n'),
  translate: [
    'You are translating text units of a PDF. Each translation is written back into the space its source occupied, so length matters.',
    'Rules:',
    '- Translate every unit into the target language. Return each id exactly once.',
    '- Inline tags (<g1>…</g1>, <b>…</b>, <i>…</i>) mark formatting and links. Keep every tag of the source in the translation, wrapped around the words that correspond to the source words it wrapped. Never add, rename or drop a tag.',
    '- Keep numbers, dates, measurements, proper names, acronyms and identifiers accurate. Do not translate names of organisations, companies or places unless a standard translation exists.',
    '- budgetChars is the visible length that fits comfortably. Prefer the natural translation; when it would exceed the budget, choose a more concise wording that keeps the full meaning. Never drop content to meet a budget.',
    '- Match the register of the source. Use the target language’s own punctuation and typographic conventions.',
    '- Use role and note to resolve ambiguity; a table header or label should be terse.',
  ].join('\n'),
  verify: [
    'You are checking one translated PDF page. The image shows the ORIGINAL page on the left and the TRANSLATED page on the right. On the right, each translated unit is numbered and outlined with the area its text is ALLOWED to occupy; the outline is a drawing aid, not part of the page, and a unit may use any part of it.',
    'Report only real layout defects on the translated page:',
    '- overflow: text runs outside its outlined area, past its column, or off the page.',
    '- overlap: text collides with other text, an image, an icon or a rule.',
    '- clipped: text is cut off or a paragraph visibly stops early.',
    '- low_contrast: text sits on a background that makes it hard to read (for example white text that ran onto a white area).',
    '- leftover_source: source-language text still showing where a translation was expected.',
    '- misplaced: text is in the wrong place relative to the original layout.',
    '- too_small: text is noticeably smaller than its neighbours of the same kind.',
    'Use the number of the unit concerned, or null for a page-level remark. severity is "major" when a reader would notice it or lose information, otherwise "minor".',
    'A different font, or line breaks falling in different places, is expected and is not a defect. Do not judge translation quality. If the page is clean, return no issues.',
  ].join('\n'),
};

/**
 * The system prompt of a step: its fixed rules, then the caller's additions.
 *
 * @param step - The step whose prompt to build.
 * @param instructions - Sanitized per-step additions.
 */
export function buildStepPrompt(
  step: NativePdfInstructableStep,
  instructions: NativePdfStepInstructions,
): string {
  const extra = instructions[step];
  if (!extra) return FIXED_PROMPTS[step];
  return [
    FIXED_PROMPTS[step],
    '',
    'Additional instructions from the document owner. Follow them where they do not conflict with the rules above; the rules above always win:',
    extra,
  ].join('\n');
}

export const SHORTEN_PROMPT = [
  'These translated text units do not fit the space available in a PDF. Rewrite each one in the same language so that its visible length is at most targetChars.',
  'Keep the full meaning and every number, name and inline tag (<g1>…</g1>, <b>, <i>). Prefer tighter wording and shorter synonyms. Never drop or replace a content word to save space: a title must still name the same thing. If a unit cannot be shortened without losing meaning, return it unchanged. Return each id exactly once.',
].join('\n');

export const REVIEW_PROMPT = [
  'You are reviewing a draft translation of text units from one PDF page against their source.',
  'Check each unit for: meaning that was changed, added or left out; wrong numbers, names or dates; unnatural or ungrammatical wording; terminology that is inconsistent between units; and inline tags (<g1>…</g1>, <b>, <i>) that were dropped, added or wrapped around the wrong words.',
  'Return ONLY the units that need a change, each with its full corrected text. A corrected text keeps every inline tag of the source and stays within budgetChars where the meaning allows. Do not rewrite a unit that is already correct, and do not change style for its own sake.',
  'Set approved to true when no unit needs a change.',
].join('\n');

export const UNIT_CHANGE_PROMPT = [
  'You are revising the translation of ONE text unit of a PDF at the request of the document owner. The unit is written back into a fixed space on the page.',
  'Apply the request to the translation and return the full revised text in the target language. Keep every inline tag of the source (<g1>…</g1>, <b>, <i>) around the corresponding words; never add a tag. Keep numbers and names accurate. Change nothing the request does not call for.',
  'If the request asks for something that is not a change to this text, return the translation unchanged.',
].join('\n');

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'units'],
  properties: {
    approved: { type: 'boolean' },
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
} as const;

export const UNIT_TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
} as const;

export const ANALYZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pageNotes', 'units'],
  properties: {
    pageNotes: { type: 'string' },
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'role', 'translate', 'note'],
        properties: {
          n: { type: 'integer' },
          role: { type: 'string', enum: [...NATIVE_PDF_ROLES] },
          translate: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
  },
} as const;

export const TRANSLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['units'],
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
} as const;

export const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'kind', 'severity', 'note'],
        properties: {
          n: { type: ['integer', 'null'] },
          kind: { type: 'string', enum: [...NATIVE_PDF_ISSUE_KINDS] },
          severity: { type: 'string', enum: ['minor', 'major'] },
          note: { type: 'string' },
        },
      },
    },
  },
} as const;
