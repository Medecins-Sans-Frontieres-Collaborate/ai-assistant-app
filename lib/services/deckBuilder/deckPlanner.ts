/**
 * Plans a deck with a model: from a brief, source text and a template's
 * layouts, the slides to build (deckPlan.ts). The plan is checked against
 * the layouts (checkDeckPlan); what blocks it goes back to the model once,
 * in words, and what still blocks is returned for the person to resolve
 * in the outline.
 */
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import { BrandBookBody } from '@/lib/utils/shared/brand/brandBook';
import {
  CheckedDeckPlan,
  DeckFill,
  DeckLayout,
  DeckLayouts,
  DeckPlan,
  MAX_BULLET_LEVEL,
  MAX_PLAN_SLIDES,
  checkDeckPlan,
  plannableLayouts,
} from '@/lib/utils/shared/documents/deckPlan';

import type { DeckPicture } from './deckInputs';

/** The longest brief a plan is made from. */
export const MAX_BRIEF_CHARS = 8_000;

const FILL_KINDS = ['text', 'bullets', 'image'] as const;

/** The model's answer: every field present ('' and [] where unused). */
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slides'],
  properties: {
    slides: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['layout', 'fills', 'notes'],
        properties: {
          layout: { type: 'string' },
          notes: { type: 'string' },
          fills: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'placeholder',
                'kind',
                'text',
                'bullets',
                'image',
                'alt',
              ],
              properties: {
                placeholder: { type: 'string' },
                kind: { type: 'string', enum: [...FILL_KINDS] },
                text: { type: 'string' },
                bullets: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['text', 'level'],
                    properties: {
                      text: { type: 'string' },
                      level: { type: 'integer' },
                    },
                  },
                },
                image: { type: 'string' },
                alt: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;

interface RawFill {
  placeholder: string;
  kind: (typeof FILL_KINDS)[number];
  text: string;
  bullets: Array<{ text: string; level: number }>;
  image: string;
  alt: string;
}
interface RawPlan {
  slides: Array<{ layout: string; notes: string; fills: RawFill[] }>;
}

const SYSTEM_PROMPT = `You plan a slide deck that will be built from an organisation's PowerPoint template. You choose a layout for each slide and say what goes in each of its placeholders; you never design or position anything yourself.

Rules:
- Use only the layouts listed, by id, and only their placeholders, by key. Put in each placeholder only what it accepts (text, bullets or a picture).
- Room is measured: each placeholder lists how many lines it holds and about how many characters fit on a line. Keep within it: text that overflows is shrunk, and text far over is refused. A bullet's line is a little shorter than the placeholder's.
- One idea per slide. Titles are short, under one line. Up to 6 bullets per slide, levels 0 and 1 only (level 2 at most rarely).
- Draw on the brief and the sources only; invent no facts, figures or quotes. Where the sources do not say, leave it out.
- Use pictures only from the list, by key, with a short alt text describing them. A logo goes on title or closing slides, at most once each.
- Speaker notes: one to three sentences that help the presenter; leave empty when there is nothing to add.
- Fill fields you do not use with "" or [].`;

/** The layouts a model may use, in words (THE PLAN CAPACITY's figures). */
export function describeLayouts(layouts: readonly DeckLayout[]): string {
  return layouts
    .map((layout) => {
      const places = layout.placeholders.map((place) => {
        const accepts = place.accepts
          .map((kind) => (kind === 'image' ? 'a picture' : kind))
          .join(', ');
        const room =
          place.role === 'picture'
            ? ''
            : `; ${place.lines} ${place.lines === 1 ? 'line' : 'lines'} of about ${place.charsPerLine} characters`;
        return `  - ${place.key} (${place.role}): ${accepts}${room}`;
      });
      return `${layout.id} "${layout.name}":\n${places.join('\n')}`;
    })
    .join('\n');
}

/** What the brand says about writing, for the planner. */
export function describeBrandVoice(book: BrandBookBody | null): string {
  if (!book) return '';
  const lines: string[] = [];
  const { language } = book;
  if (language.tone) lines.push(`Tone: ${language.tone}`);
  for (const term of language.preferred) {
    lines.push(
      `Write "${term.term}"${term.alternatives.length ? ` rather than ${term.alternatives.map((t) => `"${t}"`).join(', ')}` : ''}.`,
    );
  }
  for (const term of language.banned) {
    lines.push(
      `Never write "${term.term}"${term.alternatives.length ? `; write ${term.alternatives.map((t) => `"${t}"`).join(' or ')}` : ''}.`,
    );
  }
  return lines.length ? `Brand voice (${book.name}):\n${lines.join('\n')}` : '';
}

/** The model's answer as a plan: each fill only with what its kind uses. */
export function planFromRaw(raw: RawPlan): DeckPlan {
  return {
    slides: (raw.slides ?? []).map((slide) => ({
      layout: slide.layout,
      notes: slide.notes ?? '',
      fills: (slide.fills ?? []).map((fill): DeckFill => {
        if (fill.kind === 'image') {
          return {
            placeholder: fill.placeholder,
            kind: 'image',
            image: fill.image,
            alt: fill.alt,
          };
        }
        if (fill.kind === 'bullets') {
          return {
            placeholder: fill.placeholder,
            kind: 'bullets',
            bullets: (fill.bullets ?? []).map((bullet) => ({
              text: bullet.text,
              level: Math.min(Math.max(bullet.level, 0), MAX_BULLET_LEVEL),
            })),
          };
        }
        return { placeholder: fill.placeholder, kind: 'text', text: fill.text };
      }),
    })),
  };
}

/** What a plan is made from. */
export interface DeckPlanInput {
  brief: string;
  /** Source documents' text, by name. */
  sources: ReadonlyArray<{ name: string; text: string }>;
  layouts: DeckLayouts;
  pictures: readonly DeckPicture[];
  book: BrandBookBody | null;
  /** The language the deck is written in, as a BCP 47 tag. */
  language: string;
  model: string;
  usage: WorkflowUsageCollector;
}

function userPrompt(
  input: DeckPlanInput,
  usable: readonly DeckLayout[],
): string {
  const language =
    new Intl.DisplayNames(['en'], { type: 'language' }).of(input.language) ??
    input.language;
  const pictures = input.pictures.length
    ? input.pictures
        .map(
          (picture) =>
            `- ${picture.key}: ${picture.name}${picture.kind === 'logo' ? ' (the brand’s logo)' : ''}`,
        )
        .join('\n')
    : '(none)';
  const sources = input.sources.length
    ? input.sources
        .map((source) => `### ${source.name}\n${source.text}`)
        .join('\n\n')
    : '(none)';
  return [
    `Write the deck in ${language}. At most ${MAX_PLAN_SLIDES} slides; as many as the brief needs.`,
    `Brief:\n${input.brief.slice(0, MAX_BRIEF_CHARS)}`,
    describeBrandVoice(input.book),
    `Layouts:\n${describeLayouts(usable)}`,
    `Pictures:\n${pictures}`,
    `Sources:\n${sources}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Plans a deck, checks it against the layouts, and asks once for blocking
 * problems to be repaired.
 *
 * @returns The checked plan: `blocking` is empty when it can be built.
 * @throws When the model call fails or refuses.
 */
export async function planDeck(input: DeckPlanInput): Promise<CheckedDeckPlan> {
  const usable = plannableLayouts(input.layouts);
  const images = new Set(input.pictures.map((picture) => picture.key));
  const usableLayouts: DeckLayouts = { ...input.layouts, layouts: usable };
  const client = createAzureClient();
  const prompt = userPrompt(input, usable);
  const ask = (user: string, label: string) =>
    callStructured<RawPlan>({
      client,
      model: input.model,
      system: SYSTEM_PROMPT,
      user,
      schemaName: 'deck_plan',
      schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 16_000,
      usage: input.usage,
      usageLabel: label,
    });
  const first = checkDeckPlan(
    planFromRaw(await ask(prompt, 'deck-plan')),
    usableLayouts,
    images,
  );
  if (first.blocking.length === 0) return first;
  const repair = [
    prompt,
    `Your plan was:\n${JSON.stringify(first.plan)}`,
    `It cannot be built as it is:\n${first.blocking.map((problem) => `- ${problem.message}`).join('\n')}`,
    'Return the whole plan again with these problems resolved.',
  ].join('\n\n');
  const second = checkDeckPlan(
    planFromRaw(await ask(repair, 'deck-plan-repair')),
    usableLayouts,
    images,
  );
  return {
    ...second,
    repaired: [...first.repaired, ...second.repaired],
  };
}
