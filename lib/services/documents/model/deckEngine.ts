/**
 * The presentation engine's operations (deck_engine.py, its CONVENTIONS):
 * `extract` lists the units text work reads and `apply` writes text and
 * style edits to them, starting from the original deck every time.
 * Translation is one user; any feature that rewrites a deck's text (a
 * brand fix, a generated deck) is another. `readDeckLayouts` lists what a
 * template offers to build with and `composeDeck` builds a deck from a
 * plan over it (deckPlan.ts).
 */
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import { imageTypeOf } from '@/lib/utils/server/file/imageSignature';
import type {
  DeckLayouts,
  DeckPlan,
} from '@/lib/utils/shared/documents/deckPlan';

import { runSandboxScript } from '../sandbox/sandboxScriptRunner';
import { DECK_ENGINE_SCRIPT } from './deckEngineScript';
import { DocumentRefusedError, jobInput, throwIfRefused } from './inspect';

import { strFromU8 } from 'fflate';

const SOURCE_FILENAME = 'source.pptx';
const UNITS_FILENAME = 'units.json';
const DECK_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** How a unit should look, beside its text. */
export interface DeckUnitStyle {
  /** Font size in points (a fit may still set it smaller). */
  size?: number;
  /** `#rrggbb` for every run. */
  color?: string;
  /** Latin typeface for every run. */
  font?: string;
  /** Points to move its whole shape by. */
  dx?: number;
  dy?: number;
}

/** Edits to a deck's units, by unit id (the ids extract gave). */
export interface DeckEdits {
  /** New text, with the unit's INLINE TAGS kept. */
  text: Record<string, string>;
  styles?: Record<string, DeckUnitStyle>;
  /** BCP 47 tag the new text is marked with. */
  language?: string;
}

/** What applying edits reports, per unit and overall. */
export interface DeckEditReport {
  fonts: { sans: string; serif: string };
  /** One entry per unit: its page, number, scale and whether it fits. */
  units: Array<{
    id: string;
    page: number;
    n: number;
    scale: number;
    fits: boolean;
    kept?: boolean;
  }>;
  /** Parts written; every other part is the original's. */
  written: string[];
  /** Units whose part could not be written, left as they were. */
  kept: Array<{ id: string; reason: string }>;
}

/**
 * The units of some slides of a deck (a plain .pptx).
 *
 * @param options.pages - 1-based slides; all when empty.
 * @param options.notes - Read speaker notes too.
 * @returns The units file the engine reads back in `applyDeckEdits`.
 * @throws DocumentRefusedError when the deck cannot be opened.
 */
export async function extractDeckUnits(
  deck: Buffer,
  options: { pages: number[]; notes: boolean },
  usage?: WorkflowUsageCollector,
): Promise<Uint8Array> {
  const run = await runSandboxScript(
    'extract',
    [
      { filename: SOURCE_FILENAME, data: deck, mimeType: DECK_CONTENT_TYPE },
      jobInput({
        source: SOURCE_FILENAME,
        pages: options.pages,
        notes: options.notes,
      }),
    ],
    usage,
    DECK_ENGINE_SCRIPT,
  );
  throwIfRefused(run.files);
  const units = run.files.get(UNITS_FILENAME);
  if (!units) throw new Error('The deck engine returned no units');
  return units;
}

/**
 * Applies text and style edits to a deck (a plain .pptx), from its
 * original every time.
 *
 * @param unitsFile - What extractDeckUnits returned for this deck.
 * @returns The edited deck and the engine's report.
 * @throws DocumentRefusedError when the deck cannot be opened.
 */
export async function applyDeckEdits(
  deck: Buffer,
  unitsFile: Uint8Array,
  edits: DeckEdits,
  usage?: WorkflowUsageCollector,
): Promise<{ deck: Uint8Array; report: DeckEditReport }> {
  const run = await runSandboxScript(
    'rebuild',
    [
      { filename: SOURCE_FILENAME, data: deck, mimeType: DECK_CONTENT_TYPE },
      {
        filename: UNITS_FILENAME,
        data: Buffer.from(unitsFile),
        mimeType: 'application/json',
      },
      jobInput({
        source: SOURCE_FILENAME,
        units: UNITS_FILENAME,
        translations: edits.text,
        ...(edits.styles && Object.keys(edits.styles).length > 0
          ? { styles: edits.styles }
          : {}),
        ...(edits.language ? { language: edits.language } : {}),
      }),
    ],
    usage,
    DECK_ENGINE_SCRIPT,
  );
  throwIfRefused(run.files);
  const edited = run.files.get('translated.pptx');
  const report = run.files.get('report.json');
  if (!edited || !report) {
    throw new Error('The deck engine returned no deck');
  }
  return {
    deck: edited,
    report: JSON.parse(strFromU8(report)) as DeckEditReport,
  };
}

/** What composing reports: each slide built, and each unit's fit. */
export interface DeckComposeReport {
  slides: Array<{
    page: number;
    layout: string;
    /** Placeholder keys filled. */
    filled: string[];
    /** Whether its speaker notes were kept (a template without a notes
     * master keeps none). */
    notes: boolean;
  }>;
  units: DeckEditReport['units'];
}

/**
 * The layouts of a template (.pptx or .potx) and the placeholders a plan
 * may fill.
 *
 * @throws DocumentRefusedError when the template cannot be opened.
 */
export async function readDeckLayouts(
  template: Buffer,
  usage?: WorkflowUsageCollector,
): Promise<DeckLayouts> {
  const run = await runSandboxScript(
    'layouts',
    [
      {
        filename: SOURCE_FILENAME,
        data: template,
        mimeType: DECK_CONTENT_TYPE,
      },
      jobInput({ source: SOURCE_FILENAME }),
    ],
    usage,
    DECK_ENGINE_SCRIPT,
  );
  throwIfRefused(run.files);
  const layouts = run.files.get('layouts.json');
  if (!layouts) throw new Error('The deck engine returned no layouts');
  return JSON.parse(strFromU8(layouts)) as DeckLayouts;
}

/** The picture formats a composed deck takes, by their signature. */
const COMPOSE_PICTURE_FORMATS: Partial<
  Record<string, { extension: string; mimeType: string }>
> = {
  png: { extension: 'png', mimeType: 'image/png' },
  jpeg: { extension: 'jpg', mimeType: 'image/jpeg' },
  gif: { extension: 'gif', mimeType: 'image/gif' },
};

/**
 * Builds a deck from a template and a plan checked against its layouts
 * (checkDeckPlan): the template's own slides removed, its masters and
 * layouts kept, the text fitted.
 *
 * @param pictures - The pictures the plan places, by the keys it uses
 *   (PNG, JPEG or GIF).
 * @param options.language - BCP 47 tag the text is marked with.
 * @returns The deck (a .pptx, also from a .potx) and the engine's report.
 * @throws DocumentRefusedError when the template cannot be opened or the
 *   plan does not match it (code BAD_PLAN).
 */
export async function composeDeck(
  template: Buffer,
  plan: DeckPlan,
  pictures: ReadonlyMap<string, Uint8Array>,
  options: { language?: string } = {},
  usage?: WorkflowUsageCollector,
): Promise<{ deck: Uint8Array; report: DeckComposeReport }> {
  const images: Record<string, string> = {};
  const pictureFiles = [...pictures.entries()].map(([key, data], index) => {
    const bytes = Buffer.from(data);
    const type = imageTypeOf(bytes);
    const picture = type ? COMPOSE_PICTURE_FORMATS[type] : undefined;
    if (!picture) {
      throw new DocumentRefusedError(
        'BAD_IMAGE',
        `The picture ${key} is not a PNG, JPEG or GIF.`,
      );
    }
    // Named for what it is: the sandbox takes inputs by extension.
    const filename = `picture${index + 1}.${picture.extension}`;
    images[key] = filename;
    return { filename, data: bytes, mimeType: picture.mimeType };
  });
  const run = await runSandboxScript(
    'compose',
    [
      {
        filename: SOURCE_FILENAME,
        data: template,
        mimeType: DECK_CONTENT_TYPE,
      },
      ...pictureFiles,
      jobInput({
        source: SOURCE_FILENAME,
        plan,
        images,
        ...(options.language ? { language: options.language } : {}),
      }),
    ],
    usage,
    DECK_ENGINE_SCRIPT,
  );
  throwIfRefused(run.files);
  const deck = run.files.get('deck.pptx');
  const report = run.files.get('report.json');
  if (!deck || !report) throw new Error('The deck engine returned no deck');
  return {
    deck,
    report: JSON.parse(strFromU8(report)) as DeckComposeReport,
  };
}
