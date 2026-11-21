/**
 * Deck plans: what the presentation engine's `layouts` command reports
 * about a template, the plan `compose` builds a deck from, and the check
 * of a plan against the layouts (repairing what can be repaired and
 * stating what cannot).
 *
 * THE PLAN CAPACITY (stated once; the planner's prompt and the validator
 * cite it): a placeholder holds `lines` lines of `charsPerLine` characters
 * at its own size. A paragraph needs ceil(characters / characters per
 * line) lines; a bullet's line is shorter by its indent. The engine's fit
 * may set a box's text down to `FIT_MIN_SCALE` of its size, where a line
 * holds 1/scale as many characters and the box 1/scale as many lines. Text
 * that fits at full size is fine, text that fits only smaller will be
 * shrunk, and text that does not fit even at `FIT_MIN_SCALE` is too long.
 */
import { z } from 'zod';

/** A placeholder's role, which decides what a plan may put in it. */
export type DeckPlaceholderRole =
  | 'title'
  | 'subtitle'
  | 'body'
  | 'content'
  | 'picture';

/** What a plan puts in a placeholder. */
export type DeckFillKind = 'text' | 'bullets' | 'image';

/** A placeholder of a layout, as the engine's `layouts` reports it. */
export interface DeckPlaceholder {
  /** The placeholder's idx, or its type when it has none (a title). */
  key: string;
  role: DeckPlaceholderRole;
  accepts: DeckFillKind[];
  name: string;
  /** [x0, y0, x1, y1] in points (THE DOCUMENT MODEL's PageBox). */
  box: [number, number, number, number];
  /** First-level text size in points. */
  size: number;
  lines: number;
  charsPerLine: number;
  /** Text set sideways: its capacity is not measured; plans avoid it. */
  vertical: boolean;
}

/** A layout of the template. */
export interface DeckLayout {
  /** The layout part's name (`slideLayout2`): stable for a template. */
  id: string;
  name: string;
  /** PowerPoint's layout type (`title`, `obj`, `twoObj`, ...), if stated. */
  type: string | null;
  master: string;
  placeholders: DeckPlaceholder[];
}

/** What the engine's `layouts` command reports. */
export interface DeckLayouts {
  slideSize: { width: number; height: number };
  /** The template's own (sample) slides; a built deck keeps none. */
  slideCount: number;
  layouts: DeckLayout[];
}

/** A bullet: its text and level (0 is the first). */
export interface DeckBullet {
  text: string;
  level: number;
}

/** What one placeholder of a slide is filled with. */
export type DeckFill =
  | { placeholder: string; kind: 'text'; text: string }
  | { placeholder: string; kind: 'bullets'; bullets: DeckBullet[] }
  | {
      placeholder: string;
      kind: 'image';
      /** A key of the pictures the build is given. */
      image: string;
      alt: string;
      /** Whole at its own proportions (default), or cropped to fill. */
      fit?: 'contain' | 'cover';
    };

/** One slide of a plan. */
export interface DeckSlidePlan {
  layout: string;
  fills: DeckFill[];
  /** Speaker notes; kept when the template has a notes master. */
  notes: string;
}

/** A deck plan: the slides `compose` builds, in order. */
export interface DeckPlan {
  slides: DeckSlidePlan[];
}

/** At most this many slides are planned (the engine refuses past 60). */
export const MAX_PLAN_SLIDES = 40;
/** Bullet levels a plan may use: 0 to this. */
export const MAX_BULLET_LEVEL = 4;
/** The smallest scale the engine's fit sets text at (deck_engine MIN_SCALE). */
export const FIT_MIN_SCALE = 0.7;
/** A bullet's line is this much shorter than the placeholder's, per level. */
export const BULLET_INDENT_SHARE = 0.08;
/** Capacity comparisons allow this much: authored limits measure a hair over. */
export const CAPACITY_EPSILON = 1e-6;

/** Why a plan was changed, or why it cannot be built. */
export type DeckPlanProblemCode =
  | 'no-slides'
  | 'too-many-slides'
  | 'unknown-layout'
  | 'vertical-layout'
  | 'unknown-placeholder'
  | 'repeated-placeholder'
  | 'kind-not-accepted'
  | 'empty-fill'
  | 'unknown-image'
  | 'bullet-level'
  | 'too-long'
  | 'empty-slide';

/** A problem with a plan: repaired, or blocking the build. */
export interface DeckPlanProblem {
  code: DeckPlanProblemCode;
  /** 1-based slide, or null for the whole plan. */
  slide: number | null;
  placeholder: string | null;
  /** In words, for the planner's repair round and for the person. */
  message: string;
}

/** A plan checked against a template's layouts. */
export interface CheckedDeckPlan {
  /** The plan with every repairable problem repaired. */
  plan: DeckPlan;
  /** What was changed. */
  repaired: DeckPlanProblem[];
  /** What prevents building: empty when the plan can be built. */
  blocking: DeckPlanProblem[];
  /** Slides whose text the fit will shrink (it still fits). */
  shrunk: Array<{ slide: number; placeholder: string }>;
}

/**
 * The layouts a plan may use: those with something to fill and nothing set
 * sideways (whose capacity cannot be measured).
 *
 * @param layouts - The engine's report.
 * @returns The usable layouts, in the template's order.
 */
export function plannableLayouts(layouts: DeckLayouts): DeckLayout[] {
  return layouts.layouts.filter(
    (layout) =>
      layout.placeholders.length > 0 &&
      layout.placeholders.every((placeholder) => !placeholder.vertical),
  );
}

/**
 * Lines a placeholder's text needs at a scale (THE PLAN CAPACITY).
 *
 * @param paragraphs - Each paragraph's text and bullet level (null: no bullet).
 * @param placeholder - Where the text goes.
 * @param scale - The share of its size the text is set at (1 = full).
 * @returns Lines needed at that scale.
 */
export function linesNeeded(
  paragraphs: ReadonlyArray<{ text: string; level: number | null }>,
  placeholder: Pick<DeckPlaceholder, 'charsPerLine'>,
  scale: number,
): number {
  let total = 0;
  for (const paragraph of paragraphs) {
    const indent =
      paragraph.level === null
        ? 0
        : BULLET_INDENT_SHARE * (paragraph.level + 1);
    const perLine = Math.max(
      (placeholder.charsPerLine * (1 - indent)) / scale,
      1,
    );
    total += Math.max(
      Math.ceil([...paragraph.text].length / perLine - CAPACITY_EPSILON),
      1,
    );
  }
  return total;
}

/** How a fill's text fits a placeholder: as is, shrunk, or not at all. */
export function textFit(
  paragraphs: ReadonlyArray<{ text: string; level: number | null }>,
  placeholder: Pick<DeckPlaceholder, 'charsPerLine' | 'lines'>,
): 'fits' | 'shrinks' | 'too-long' {
  if (
    linesNeeded(paragraphs, placeholder, 1) <=
    placeholder.lines + CAPACITY_EPSILON
  ) {
    return 'fits';
  }
  const room = placeholder.lines / FIT_MIN_SCALE;
  return linesNeeded(paragraphs, placeholder, FIT_MIN_SCALE) <=
    room + CAPACITY_EPSILON
    ? 'shrinks'
    : 'too-long';
}

function paragraphsOf(
  fill: DeckFill,
): Array<{ text: string; level: number | null }> {
  if (fill.kind === 'bullets') {
    return fill.bullets.map((bullet) => ({
      text: bullet.text,
      level: bullet.level,
    }));
  }
  if (fill.kind === 'text') {
    return fill.text.split('\n').map((text) => ({ text, level: null }));
  }
  return [];
}

/**
 * Bullets moved into a text-only placeholder: a title takes them as one
 * line, a subtitle as one paragraph each.
 */
function bulletsAsText(
  bullets: readonly DeckBullet[],
  role: DeckPlaceholderRole,
): string {
  return bullets
    .map((bullet) => bullet.text.trim())
    .filter(Boolean)
    .join(role === 'title' ? ' ' : '\n');
}

const lines = (count: number) => `${count} ${count === 1 ? 'line' : 'lines'}`;

/**
 * Checks a plan against a template's layouts. What can be repaired
 * without judgement is (and listed); what cannot is returned as blocking,
 * for a model to repair or the person to be told.
 *
 * @param plan - The plan, as a model or the person left it.
 * @param layouts - The engine's report for the template.
 * @param images - The keys of the pictures the build will be given.
 * @returns The repaired plan, what was repaired, and what blocks it.
 */
export function checkDeckPlan(
  plan: DeckPlan,
  layouts: DeckLayouts,
  images: ReadonlySet<string> = new Set(),
): CheckedDeckPlan {
  const repaired: DeckPlanProblem[] = [];
  const blocking: DeckPlanProblem[] = [];
  const shrunk: CheckedDeckPlan['shrunk'] = [];
  const byId = new Map(layouts.layouts.map((layout) => [layout.id, layout]));
  let slides = plan.slides;
  if (slides.length === 0) {
    blocking.push({
      code: 'no-slides',
      slide: null,
      placeholder: null,
      message: 'The plan has no slides.',
    });
  }
  if (slides.length > MAX_PLAN_SLIDES) {
    repaired.push({
      code: 'too-many-slides',
      slide: null,
      placeholder: null,
      message: `The plan had ${slides.length} slides; the first ${MAX_PLAN_SLIDES} are kept.`,
    });
    slides = slides.slice(0, MAX_PLAN_SLIDES);
  }
  const kept: DeckSlidePlan[] = [];
  slides.forEach((slide, index) => {
    const number = index + 1;
    const layout = byId.get(slide.layout);
    if (!layout) {
      blocking.push({
        code: 'unknown-layout',
        slide: number,
        placeholder: null,
        message: `Slide ${number} uses the layout "${slide.layout}", which the template does not have.`,
      });
      kept.push(slide);
      return;
    }
    if (layout.placeholders.some((placeholder) => placeholder.vertical)) {
      blocking.push({
        code: 'vertical-layout',
        slide: number,
        placeholder: null,
        message: `Slide ${number} uses "${layout.name}", whose text is set sideways; choose another layout.`,
      });
    }
    const places = new Map(
      layout.placeholders.map((placeholder) => [placeholder.key, placeholder]),
    );
    const seen = new Set<string>();
    const fills: DeckFill[] = [];
    for (const original of slide.fills) {
      const place = places.get(original.placeholder);
      const where = { slide: number, placeholder: original.placeholder };
      if (!place) {
        repaired.push({
          code: 'unknown-placeholder',
          ...where,
          message: `Slide ${number}: "${layout.name}" has no placeholder "${original.placeholder}"; its content was dropped.`,
        });
        continue;
      }
      if (seen.has(place.key)) {
        repaired.push({
          code: 'repeated-placeholder',
          ...where,
          message: `Slide ${number}: "${place.name}" was filled twice; the first is kept.`,
        });
        continue;
      }
      let fill: DeckFill = original;
      if (!place.accepts.includes(fill.kind)) {
        if (fill.kind === 'bullets' && place.accepts.includes('text')) {
          fill = {
            placeholder: fill.placeholder,
            kind: 'text',
            text: bulletsAsText(fill.bullets, place.role),
          };
          repaired.push({
            code: 'kind-not-accepted',
            ...where,
            message: `Slide ${number}: "${place.name}" takes no bullets; they were set as lines.`,
          });
        } else {
          repaired.push({
            code: 'kind-not-accepted',
            ...where,
            message: `Slide ${number}: "${place.name}" cannot hold ${fill.kind === 'image' ? 'a picture' : 'text'}; it was dropped.`,
          });
          continue;
        }
      }
      if (fill.kind === 'bullets') {
        const given = fill.bullets;
        const levels = given.map((bullet) => ({
          text: bullet.text.trim(),
          level: Math.min(
            Math.max(Math.round(bullet.level) || 0, 0),
            MAX_BULLET_LEVEL,
          ),
        }));
        if (levels.some((bullet, at) => bullet.level !== given[at].level)) {
          repaired.push({
            code: 'bullet-level',
            ...where,
            message: `Slide ${number}: bullet levels were kept within 0 to ${MAX_BULLET_LEVEL}.`,
          });
        }
        fill = {
          ...fill,
          bullets: levels.filter((bullet) => bullet.text),
        };
      }
      if (fill.kind === 'image' && !images.has(fill.image)) {
        repaired.push({
          code: 'unknown-image',
          ...where,
          message: `Slide ${number}: the picture "${fill.image}" was not given; it was dropped.`,
        });
        continue;
      }
      const empty =
        (fill.kind === 'text' && !fill.text.trim()) ||
        (fill.kind === 'bullets' && fill.bullets.length === 0);
      if (empty) {
        repaired.push({
          code: 'empty-fill',
          ...where,
          message: `Slide ${number}: "${place.name}" was left empty.`,
        });
        continue;
      }
      if (fill.kind !== 'image') {
        const fit = textFit(paragraphsOf(fill), place);
        if (fit === 'too-long') {
          blocking.push({
            code: 'too-long',
            ...where,
            message: `Slide ${number}: the text for "${place.name}" needs ${lines(linesNeeded(paragraphsOf(fill), place, 1))}; it holds ${lines(place.lines)} of about ${place.charsPerLine} characters, and the fit can make room for at most ${lines(Math.floor(place.lines / FIT_MIN_SCALE))}, shorter. Shorten it or split the slide.`,
          });
        } else if (fit === 'shrinks') {
          shrunk.push({ slide: number, placeholder: place.key });
        }
      }
      seen.add(place.key);
      fills.push(fill);
    }
    if (fills.length === 0) {
      repaired.push({
        code: 'empty-slide',
        slide: number,
        placeholder: null,
        message: `Slide ${number} had nothing to show and was dropped.`,
      });
      return;
    }
    kept.push({ layout: slide.layout, fills, notes: slide.notes ?? '' });
  });
  if (slides.length > 0 && kept.length === 0) {
    blocking.push({
      code: 'no-slides',
      slide: null,
      placeholder: null,
      message: 'No slide of the plan has anything to show.',
    });
  }
  return { plan: { slides: kept }, repaired, blocking, shrunk };
}

/** Generous bounds for a plan sent from the browser; the check does the rest. */
const planText = (max: number) => z.string().max(max);

/** A plan as the browser sends it (the person's edited outline). */
export const DeckPlanSchema = z.object({
  slides: z
    .array(
      z.object({
        layout: z.string().min(1).max(80),
        notes: planText(4_000).default(''),
        fills: z
          .array(
            z.discriminatedUnion('kind', [
              z.object({
                placeholder: z.string().min(1).max(40),
                kind: z.literal('text'),
                text: planText(4_000),
              }),
              z.object({
                placeholder: z.string().min(1).max(40),
                kind: z.literal('bullets'),
                bullets: z
                  .array(
                    z.object({
                      text: planText(1_000),
                      level: z.number().int().min(0).max(MAX_BULLET_LEVEL),
                    }),
                  )
                  .max(30),
              }),
              z.object({
                placeholder: z.string().min(1).max(40),
                kind: z.literal('image'),
                image: z.string().min(1).max(80),
                alt: planText(300),
                fit: z.enum(['contain', 'cover']).optional(),
              }),
            ]),
          )
          .max(12),
      }),
    )
    .max(MAX_PLAN_SLIDES),
});
