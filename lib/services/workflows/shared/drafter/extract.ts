/**
 * Brief extraction: the model PROPOSES items, code decides what they are
 * worth. Every proposal arrives with a source id and an excerpt, and the
 * excerpt is looked up in the source text. What is not found is kept, marked
 * "Not found in source", and cannot be included until a person resolves it.
 *
 * Kind-agnostic: nothing here knows what the versions will be written for.
 */
import { numbersSupported } from '@/lib/utils/shared/drafter/core/grounding';
import {
  attributionNearExcerpt,
  locateExcerpt,
} from '@/lib/utils/shared/drafter/core/verify';
import { markdownToProse } from '@/lib/utils/shared/markdown/markdownToProse';

import {
  BriefItemKind,
  DRAFTER_LIMITS,
  ExtractResponse,
  ExtractedItem,
} from '@/types/drafter';

const ITEM_KINDS: readonly BriefItemKind[] = [
  'quote',
  'testimony',
  'fact',
  'figure',
  'context',
];

export const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['keyMessage', 'callToAction', 'language', 'items'],
  properties: {
    keyMessage: {
      type: 'string',
      description:
        'One sentence: the single thing a reader should take away. No ' +
        'numbers or names that are not in the sources.',
    },
    callToAction: {
      type: ['string', 'null'],
      description: 'What the sources ask readers to do, or null if nothing.',
    },
    language: {
      type: 'string',
      description: 'English name of the language the sources are written in.',
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind',
          'text',
          'speakerName',
          'speakerRole',
          'sourceId',
          'excerpt',
        ],
        properties: {
          kind: { type: 'string', enum: [...ITEM_KINDS] },
          text: {
            type: 'string',
            description:
              'quote/testimony: the exact words, copied character for ' +
              'character, without quotation marks. Otherwise: one plain ' +
              'sentence stating the point.',
          },
          speakerName: { type: ['string', 'null'] },
          speakerRole: { type: ['string', 'null'] },
          sourceId: { type: 'string' },
          excerpt: {
            type: 'string',
            description:
              'The passage of the source that proves this item, copied ' +
              'character for character.',
          },
        },
      },
    },
  },
};

export interface RawExtractResponse {
  keyMessage: string;
  callToAction: string | null;
  language: string;
  items: Array<{
    kind: string;
    text: string;
    speakerName: string | null;
    speakerRole: string | null;
    sourceId: string;
    excerpt: string;
  }>;
}

export function buildExtractSystemPrompt(): string {
  return `You prepare the factual base for public communications. From the source material, pull out what could be said publicly, so that a person can decide what to use.

ORDER OF PREFERENCE. People respond to people. Look first for direct quotes and first-person testimony from staff, patients and community members. Then facts and context. Figures and statistics come last and only when they matter.

RULES
- Use ONLY the sources. Never add knowledge of your own.
- "quote" and "testimony": "text" must be the speaker's exact words, copied character for character, with no quotation marks around them and nothing trimmed from the middle. If you cannot copy them exactly, do not include the item.
- Name a speaker only when the source names them next to the words. Otherwise null. Never guess a name or a role.
- "fact", "figure", "context": "text" is one plain sentence. Every number in it must appear in "excerpt" exactly as written there.
- "excerpt" is copied character for character from the source named in "sourceId". It will be checked by a program; a paraphrased excerpt is rejected.
- Keep each item self-contained and short. Prefer 6 to 15 strong items over many weak ones.
- Do not repeat items that are already in the brief.
- Write "keyMessage", "callToAction" and non-quote "text" in the language of the sources.`;
}

export interface ExtractSourceInput {
  id: string;
  name: string;
  text: string;
}

/** Per-source token budget; keeps many sources from crowding the prompt. */
export const SOURCE_TOKEN_BUDGET = 14_000;
/**
 * Characters kept BEFORE the tokeniser sees a source. Tokenising is the
 * expensive step and its input would otherwise be as long as the caller
 * likes. Generous on purpose: ordinary prose runs at 3 to 5 characters a
 * token, so the token budget, not this, decides where real text is cut.
 */
export const SOURCE_PRE_SLICE_CHARS = SOURCE_TOKEN_BUDGET * 8;
export const MAX_EXISTING_ITEMS = 60;
const MAX_SOURCE_NAME_CHARS = 300;
/** Source ids are minted as UUIDs; slugs and prefixed ids fit as well. */
const SOURCE_ID_PATTERN = /^[\w.:-]{1,100}$/u;

/**
 * The request's sources, rebuilt from known fields. A source whose id is not
 * id-shaped is skipped: the id is echoed into the prompt and keyed on when
 * the model's proposals are verified.
 */
export function parseExtractSources(raw: unknown): ExtractSourceInput[] {
  const sources: ExtractSourceInput[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (sources.length >= DRAFTER_LIMITS.MAX_SOURCES) break;
    const record = (entry as { record?: unknown } | null)?.record as
      | { id?: unknown; name?: unknown }
      | null
      | undefined;
    const text = (entry as { text?: unknown } | null)?.text;
    if (
      !record ||
      typeof record.id !== 'string' ||
      typeof record.name !== 'string' ||
      typeof text !== 'string' ||
      !SOURCE_ID_PATTERN.test(record.id) ||
      seen.has(record.id)
    ) {
      continue;
    }
    // Prose, whatever the client sent: an excerpt is verified against this
    // text and then shown, quoted and linked as the page's own words.
    const cut = markdownToProse(text.slice(0, SOURCE_PRE_SLICE_CHARS));
    if (!cut.trim()) continue;
    seen.add(record.id);
    sources.push({
      id: record.id,
      name: record.name.slice(0, MAX_SOURCE_NAME_CHARS),
      text: cut,
    });
  }
  return sources;
}

/** Items already in the brief: a known kind and capped text, nothing else. */
export function parseExistingItems(
  raw: unknown,
): Array<{ kind: BriefItemKind; text: string }> {
  const existing: Array<{ kind: BriefItemKind; text: string }> = [];
  // Cut before walking: the list's length is not the caller's to choose.
  const entries: unknown[] = Array.isArray(raw)
    ? raw.slice(0, MAX_EXISTING_ITEMS * 4)
    : [];
  for (const entry of entries) {
    if (existing.length >= MAX_EXISTING_ITEMS) break;
    const item = entry as { kind?: unknown; text?: unknown } | null;
    if (
      !item ||
      typeof item.kind !== 'string' ||
      typeof item.text !== 'string' ||
      !isItemKind(item.kind)
    ) {
      continue;
    }
    existing.push({
      kind: item.kind,
      text: item.text.slice(0, DRAFTER_LIMITS.MAX_ITEM_CHARS),
    });
  }
  return existing;
}

/**
 * A value placed inside the `<source …>` tag. Anything that could close the
 * attribute or the tag is removed, so a file name cannot open a second
 * source or end this one.
 */
function tagAttribute(value: string): string {
  return value
    .replace(/[<>]/gu, '')
    .replace(/"/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

export function buildExtractUserPrompt(
  sources: ExtractSourceInput[],
  existing: Array<{ kind: string; text: string }>,
): string {
  const parts: string[] = [];
  for (const source of sources) {
    parts.push(
      `<source id="${tagAttribute(source.id)}" name="${tagAttribute(source.name)}">\n${source.text}\n</source>`,
    );
  }
  if (existing.length > 0) {
    parts.push(
      `ALREADY IN THE BRIEF (do not repeat):\n${existing
        .map((item) => `- [${item.kind}] ${item.text}`)
        .join('\n')}`,
    );
  }
  return parts.join('\n\n');
}

function isItemKind(value: string): value is BriefItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

/**
 * Turns the model's proposals into items with a verification the CODE
 * assigned. Nothing in the result is trusted because the model said so.
 */
export function normalizeExtractResponse(
  raw: RawExtractResponse,
  sources: ExtractSourceInput[],
): ExtractResponse {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const items: ExtractedItem[] = [];

  for (const proposal of Array.isArray(raw.items) ? raw.items : []) {
    if (items.length >= DRAFTER_LIMITS.MAX_BRIEF_ITEMS) break;
    if (!proposal || !isItemKind(proposal.kind)) continue;
    const text = String(proposal.text ?? '')
      .trim()
      // The words are stored bare; quotation marks are added when placed.
      .replace(/^["“”«»„]+|["“”«»„]+$/gu, '')
      .slice(0, DRAFTER_LIMITS.MAX_ITEM_CHARS);
    if (!text) continue;

    const source = byId.get(String(proposal.sourceId ?? ''));
    const excerpt = String(proposal.excerpt ?? '').trim();
    const spoken = proposal.kind === 'quote' || proposal.kind === 'testimony';

    // For spoken words the TEXT is what gets published, so the text itself
    // must be in the source. For a statement, the excerpt is the evidence
    // and the statement may not carry a number the excerpt lacks.
    const range = source
      ? locateExcerpt(source.text, spoken ? text : excerpt)
      : null;
    const verbatim =
      !!source && !!range && (spoken || numbersSupported(text, excerpt));

    const name = proposal.speakerName?.trim();
    const attribution =
      spoken &&
      name &&
      source &&
      range &&
      attributionNearExcerpt(source.text, range, name)
        ? { name, role: proposal.speakerRole?.trim() || undefined }
        : undefined;

    items.push({
      kind: proposal.kind,
      text,
      attribution,
      provenance:
        verbatim && source
          ? [
              {
                sourceId: source.id,
                excerpt: spoken
                  ? source.text.slice(range.start, range.end)
                  : excerpt,
              },
            ]
          : [],
      verified: verbatim ? 'verbatim' : 'unverified',
    });
  }

  return {
    keyMessage: String(raw.keyMessage ?? '')
      .trim()
      .slice(0, 600),
    callToAction: raw.callToAction?.trim().slice(0, 300) || undefined,
    language:
      String(raw.language ?? '')
        .trim()
        .slice(0, 60) || 'English',
    items,
  };
}
