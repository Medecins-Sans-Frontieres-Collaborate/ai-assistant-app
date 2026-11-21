import {
  NATIVE_PDF_FIX_ACTIONS,
  NATIVE_PDF_ISSUE_KINDS,
  NATIVE_PDF_ROLES,
  NativePdfInstructableStep,
  NativePdfLanguage,
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
    'Also give names: the proper names and fixed terms on the page that a document would repeat, each exactly as written and at most 20: names of projects, programmes, products, organisations and people, acronyms, and the short label or heading phrases that a document of this kind repeats from page to page (for example "Status Review" in the title "Status Review: Project X", or the caption of a box that every project page has). List one also when it is only part of a unit. One decision is then made for each across the whole document, so that no page translates a name another page keeps.',
    'Also give pageNotes: one or two sentences on what the page is and anything that affects translation (tables, repeated headers, text inside images that cannot be changed).',
    'Judge from the image and the text together. Return every unit number from the list exactly once and no others.',
  ].join('\n'),
  translate: [
    'You are translating text units of a PDF. Each translation is written back into the space its source occupied, so length matters.',
    'Rules:',
    '- Translate every unit into the target language. Return each id exactly once.',
    '- Inline tags (<g1>…</g1>, <b>…</b>, <i>…</i>) mark formatting and links. Keep every tag of the source in the translation, wrapped around the words that correspond to the source words it wrapped. Never add, rename or drop a tag.',
    '- Keep numbers, dates, measurements, proper names, acronyms and identifiers accurate. Do not translate names of organisations, companies or places unless a standard translation exists.',
    '- budgetChars is the visible length that fits comfortably. Prefer the natural translation; when it would exceed the budget, choose a more concise wording that keeps the full meaning. Never drop content to meet a budget, never abbreviate a word the source writes out in full, and keep the articles and prepositions the language needs.',
    '- A line break inside a unit separates items the author put on lines of their own. Keep every line break, between the same items; never join the items with punctuation and never add a line break.',
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
    'Compare with the original: text that wraps onto a rule or divider the original cleared, leaves the card or box it belongs to, or closes the gap to the next element until they touch, is a defect even when it is inside its outline.',
    'For every issue also prescribe, as fix, the one change most likely to cure it. The message lists the page size and, per unit, its font size, how far the layout already shrank it, and its area, all in points:',
    '- action "smaller": set the unit in a smaller font. percent is the new size as a percentage of the size it is shown at now (70 to 95). Use it when the text is a little too long: it wraps one line too many, or just reaches a rule or a neighbour.',
    '- action "shorten": have the translation reworded more briefly. percent is the new length as a percentage of the current one (50 to 90). Use it when the text is far too long, and for too_small: text already smaller than its neighbours must get shorter, not smaller.',
    '- action "move": shift the unit. dx and dy are the move in points, +x to the right and +y down; one point is 1/72 inch and the page size tells you the scale of the image. Use it when the text has enough space but sits on a rule, an icon or a neighbour that a small shift would clear.',
    '- action "none": nothing above would help (leftover_source, a page-level remark).',
    'Set percent to 100 and dx, dy to 0 where the action does not use them.',
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
  return withAdditions(FIXED_PROMPTS[step], instructions[step]);
}

/**
 * The framing of caller-supplied additions, for a prompt that is not one of
 * the instructable steps' own.
 *
 * @param prompt - The fixed rules.
 * @param extra - Sanitized additions; empty leaves the rules as they are.
 */
function withAdditions(prompt: string, extra: string | undefined): string {
  if (!extra) return prompt;
  return [
    prompt,
    '',
    'Additional instructions from the document owner. Follow them where they do not conflict with the rules above; the rules above always win:',
    extra,
  ].join('\n');
}

export const LANGUAGE_PROMPT = [
  'A document is about to be translated page by page, by separate requests that cannot see each other. You are given the target language as a person typed it. Pin it down so that every page is written in exactly the same language, variety and spelling.',
  'Return:',
  '- code: the IETF language tag (the ISO 639-1 code where one exists, otherwise ISO 639-3; add a script or region subtag only when the name asks for one), for example "ht" for Haitian Creole or "jam" for Jamaican Patois. An empty string when the language cannot be identified.',
  '- name: the unambiguous English name of the language.',
  '- note: one or two sentences, at most 240 characters, saying which variety, register and spelling system to write in. Needed when the name could mean more than one language or dialect, or when the language has competing orthographies: choose the one most used for formal written documents and name it, and say what to avoid. An empty string when there is nothing to settle.',
].join('\n');

export const LANGUAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'name', 'note'],
  properties: {
    code: { type: 'string' },
    name: { type: 'string' },
    note: { type: 'string' },
  },
} as const;

const TERMS_RULES = [
  'A document is being translated page by page, by separate requests that cannot see each other. You are given names and fixed terms found on its pages. Decide once how each is handled; your decision is applied on every page.',
  'For every candidate return:',
  '- keep: true when it is written the same way in the target language: names of people, organisations, companies, brands and products, coined or branded project and programme names, codes, and acronyms that are used unchanged. false when a reader of the target language needs it translated: a descriptive title or term made of ordinary words, a place or organisation with an established name in the target language, an acronym that has its own form there.',
  '  An ordinary word or phrase is never kept, however short and however it is capitalised: a column header, a label, a caption or a heading phrase ("TIME", "Status Review", "Cost") is keep: false with its translation as target, also when the translation happens to be spelt the same as the source ("TYPE" and "PAGE" in French).',
  '- target: when keep is false, the translation, worded as briefly as the source and in the same title style. When keep is true, the source exactly.',
  'Treat alike what is alike: candidates of the same kind (for example the titles of the projects in one list) are all kept or all translated, and a word shared by several candidates is translated the same way in each. "Already decided" lists earlier decisions for this document: follow their pattern and their wording.',
  'Return every candidate exactly once, with source copied exactly, and no others.',
].join('\n');

/**
 * The prompt that decides how names and recurring terms are handled.
 *
 * @param extra - The caller's additions to the analyze step, which is
 *   where a person says what must be left untranslated.
 */
export function buildTermsPrompt(extra: string | undefined): string {
  return withAdditions(TERMS_RULES, extra);
}

export const TERMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['terms'],
  properties: {
    terms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'keep', 'target'],
        properties: {
          source: { type: 'string' },
          keep: { type: 'boolean' },
          target: { type: 'string' },
        },
      },
    },
  },
} as const;

/**
 * How a model step is told the target language: the label the person
 * chose, then what the document brief settled about it, so that every
 * request writes in the same variety and spelling.
 *
 * @param label - Display label of the target language.
 * @param language - The brief's language, when it has one.
 */
export function targetLanguageLines(
  label: string,
  language: NativePdfLanguage | undefined,
): string {
  const named =
    language?.name && language.name.toLowerCase() !== label.toLowerCase()
      ? ` (${language.name}${language.code ? `, ${language.code}` : ''})`
      : language?.code
        ? ` (${language.code})`
        : '';
  return [
    `Target language: ${label}${named}`,
    language?.note
      ? `Write every unit in this variety and spelling, as every other page does: ${language.note}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const TERMS_REPAIR_PROMPT = [
  'These translated text units of one document do not use the wording the document has fixed for a name or term. Each unit lists its terms: source is the term as the source text writes it, target is the wording every page must use for it.',
  'Rewrite each translation in the same language so that every listed target appears in it, written exactly as given apart from the capital letter a sentence position calls for. Change nothing else beyond what grammar then requires (articles, agreement, elision). Keep every number, inline tag (<g1>…</g1>, <b>, <i>) and line break where it is, and do not make the text longer than it needs to be.',
  'Return each id exactly once.',
].join('\n');

export const SHORTEN_PROMPT = [
  'These translated text units do not fit the space available in a PDF. Rewrite each one in the same language so that its visible length is at most targetChars.',
  'Keep the full meaning and every number, name and inline tag (<g1>…</g1>, <b>, <i>). A unit may list fixed: wordings the document uses on every page, which must stay in the text exactly as given. Prefer tighter wording and shorter synonyms. Never drop or replace a content word to save space: a title must still name the same thing. Never abbreviate a word that is written out in full, and keep the articles and prepositions the language needs: text set a little smaller reads better than "Eval." for "Evaluation". Keep every line break where it is. If a unit cannot be shortened without losing meaning, return it unchanged. Return each id exactly once.',
].join('\n');

export const REVIEW_PROMPT = [
  'You are reviewing a draft translation of text units from one PDF page against their source.',
  'Check each unit for: meaning that was changed, added or left out; wrong numbers, names or dates; unnatural or ungrammatical wording; terminology that is inconsistent between units; and inline tags (<g1>…</g1>, <b>, <i>) that were dropped, added or wrapped around the wrong words.',
  'Return ONLY the units that need a change, each with its full corrected text. A corrected text keeps every inline tag and line break of the source and stays within budgetChars where the meaning allows. Do not rewrite a unit that is already correct, and do not change style for its own sake.',
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
  required: ['pageNotes', 'names', 'units'],
  properties: {
    pageNotes: { type: 'string' },
    names: { type: 'array', items: { type: 'string' } },
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
        required: ['n', 'kind', 'severity', 'note', 'fix'],
        properties: {
          n: { type: ['integer', 'null'] },
          kind: { type: 'string', enum: [...NATIVE_PDF_ISSUE_KINDS] },
          severity: { type: 'string', enum: ['minor', 'major'] },
          note: { type: 'string' },
          fix: {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'percent', 'dx', 'dy'],
            properties: {
              action: { type: 'string', enum: [...NATIVE_PDF_FIX_ACTIONS] },
              percent: { type: 'number' },
              dx: { type: 'number' },
              dy: { type: 'number' },
            },
          },
        },
      },
    },
  },
} as const;
