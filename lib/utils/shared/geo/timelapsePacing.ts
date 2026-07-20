/**
 * Pacing for the map time-lapse: how long each date is held, how long each
 * auto-opened card lives, and which arrivals get one.
 *
 * Lives in lib rather than beside the Map components because the settings
 * store owns the persisted half of it — a viewer's comfortable reading speed
 * is a preference, not workspace view state.
 */

export interface MapTimelapseSettings {
  /** How long a single auto-opened card stays on screen. */
  cardDurationMs: number;
  /** Most cards opened at any one date. */
  maxCardsPerDate: number;
}

export const DEFAULT_MAP_TIMELAPSE: MapTimelapseSettings = {
  cardDurationMs: 2600,
  maxCardsPerDate: 3,
};

/** Slider bounds; also the clamp applied to anything read from storage. */
export const CARD_DURATION_MIN_MS = 1200;
export const CARD_DURATION_MAX_MS = 6000;
export const CARD_DURATION_STEP_MS = 200;
export const MAX_CARDS_MIN = 1;
export const MAX_CARDS_MAX = 6;

/**
 * How far into a card's life the next one opens. Derived rather than fixed
 * so the overlap stays proportional at any configured duration.
 */
const OVERLAP_FRACTION = 0.35;
/** Quiet beat after the last card closes, before the jump. */
const CARD_TAIL_MS = 350;
/** A date where nothing arrives (only endings) needs far less time. */
const EMPTY_DWELL_MS = 1300;
/**
 * Extra hold per arrival that did NOT get a card, so a date that lands
 * twenty places reads as a bigger moment than one that lands three…
 */
const PER_EXTRA_ARRIVAL_MS = 110;
/** …up to a point: one crowded date must not stall the whole sweep. */
const EXTRA_ARRIVAL_CAP_MS = 2400;
/**
 * Reduced motion slows the whole sweep: state changes should read as
 * discrete beats rather than a flow.
 */
const REDUCED_MOTION_FACTOR = 1.35;

export function clampTimelapseSettings(
  settings: Partial<MapTimelapseSettings> | undefined,
): MapTimelapseSettings {
  const duration = Number(settings?.cardDurationMs);
  const maxCards = Number(settings?.maxCardsPerDate);
  return {
    cardDurationMs: Number.isFinite(duration)
      ? Math.min(CARD_DURATION_MAX_MS, Math.max(CARD_DURATION_MIN_MS, duration))
      : DEFAULT_MAP_TIMELAPSE.cardDurationMs,
    maxCardsPerDate: Number.isFinite(maxCards)
      ? Math.min(MAX_CARDS_MAX, Math.max(MAX_CARDS_MIN, Math.round(maxCards)))
      : DEFAULT_MAP_TIMELAPSE.maxCardsPerDate,
  };
}

/** Delay between consecutive cards — they overlap rather than queue. */
export function cardStaggerMs(cardDurationMs: number): number {
  return Math.round(cardDurationMs * OVERLAP_FRACTION);
}

/**
 * How long to hold one date.
 *
 * Long enough for its cards to open, be read, and clear — plus a bonus for
 * arrivals the cards couldn't cover, so time spent on a date tracks how much
 * actually happened there rather than being uniform.
 */
export function keyframeDwellMs(options: {
  /** Cards that will actually open here. */
  cardCount: number;
  /** Everything that arrives here, carded or not. */
  arrivalCount: number;
  cardDurationMs: number;
  reducedMotion: boolean;
}): number {
  const { cardCount, arrivalCount, cardDurationMs, reducedMotion } = options;
  const cards =
    cardCount === 0
      ? EMPTY_DWELL_MS
      : (cardCount - 1) * cardStaggerMs(cardDurationMs) +
        cardDurationMs +
        CARD_TAIL_MS;
  const uncarded = Math.max(0, arrivalCount - cardCount);
  const bonus = Math.min(EXTRA_ARRIVAL_CAP_MS, uncarded * PER_EXTRA_ARRIVAL_MS);
  const total = cards + bonus;
  return Math.round(reducedMotion ? total * REDUCED_MOTION_FACTOR : total);
}

/**
 * Which of a date's arrivals get a card.
 *
 * Everything, when there are few enough to read. Otherwise a sample taken at
 * an even stride through the (prominence-ordered) shortlist, with a random
 * starting offset: cards shown at the same moment overlap on screen, so
 * drawing them from spread-apart positions keeps a crowded date from
 * spotlighting the same neighbouring cluster three times, and the random
 * offset means replaying the sweep surfaces different places.
 */
export function sampleSpotlight(
  arrivalIds: string[],
  maxCards: number,
  random: () => number = Math.random,
): string[] {
  const limit = Math.max(1, Math.round(maxCards));
  if (arrivalIds.length <= limit) return arrivalIds;
  if (limit === 1) {
    return [arrivalIds[Math.floor(random() * Math.min(arrivalIds.length, 2))]];
  }

  // Shortlist: prominence still decides who is eligible, the stride only
  // decides which of the eligible are spread across the shown set.
  const pool = arrivalIds.slice(0, limit * 2);
  const stride = Math.max(1, Math.floor((pool.length - 1) / (limit - 1)));
  const maxOffset = Math.max(0, pool.length - 1 - (limit - 1) * stride);
  const offset = Math.floor(random() * (maxOffset + 1));
  return Array.from(
    { length: limit },
    (_, index) => pool[offset + index * stride],
  );
}
