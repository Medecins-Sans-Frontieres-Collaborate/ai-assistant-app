'use client';

import type {
  DeckBuildState,
  DeckOutlineState,
} from '@/lib/services/deckBuilder/deckBuilderJobs';

import type {
  DeckPlan,
  DeckPlanProblem,
} from '@/lib/utils/shared/documents/deckPlan';

/**
 * The browser's side of the deck builder (app/api/deck-builder): outlines
 * and builds are started here and read until they end.
 */

/** An outline as read. */
export interface DeckOutlineReading {
  id: string;
  state: DeckOutlineState;
}

/** A build as read. */
export interface DeckBuildReading {
  id: string;
  state: DeckBuildState;
}

/** Work refused because the person's outlines or builds are all running. */
export class DeckBuilderBusyError extends Error {
  constructor(
    message: string,
    readonly activeName: string | null,
  ) {
    super(message);
    this.name = 'DeckBuilderBusyError';
  }
}

/** An outline or build that is no longer stored. */
export class DeckWorkGoneError extends Error {
  constructor() {
    super('This deck work is no longer stored.');
    this.name = 'DeckWorkGoneError';
  }
}

/** A plan the server will not build, with why (in words). */
export class DeckPlanRefusedError extends Error {
  constructor(readonly problems: DeckPlanProblem[]) {
    super('The outline cannot be built as it is.');
    this.name = 'DeckPlanRefusedError';
  }
}

async function dataOf<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null);
  if (response.status === 409) {
    throw new DeckBuilderBusyError(
      body?.error ?? fallback,
      typeof body?.details?.activeName === 'string'
        ? body.details.activeName
        : null,
    );
  }
  if (response.status === 422 && Array.isArray(body?.details?.problems)) {
    throw new DeckPlanRefusedError(body.details.problems);
  }
  if (response.status === 404) throw new DeckWorkGoneError();
  if (!response.ok || !body?.success) {
    throw new Error(body?.error || `${fallback} (${response.status})`);
  }
  return body.data as T;
}

/** What an outline is made from. */
export interface DeckOutlineRequest {
  template: { file: string; name: string };
  bookId?: string;
  brief: string;
  sources: Array<{ file: string; name: string }>;
  pictures: Array<{ file: string; name: string }>;
  /** BCP 47 tag the deck is written in. */
  language: string;
}

/**
 * Starts an outline.
 *
 * @throws DeckBuilderBusyError when the person's outlines are all running.
 */
export async function startDeckOutline(
  request: DeckOutlineRequest,
): Promise<DeckOutlineReading> {
  const data = await dataOf<{ outlineId: string; state: DeckOutlineState }>(
    await fetch('/api/deck-builder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }),
    'Could not start the outline',
  );
  return { id: data.outlineId, state: data.state };
}

/**
 * Builds a deck from a finished outline and the plan as edited.
 *
 * @param locale - The reader's, for the brand review's notes.
 * @throws DeckPlanRefusedError when the plan cannot be built;
 *   DeckBuilderBusyError when the person's builds are all running.
 */
export async function startDeckBuild(input: {
  outlineId: string;
  plan: DeckPlan;
  name: string;
  locale: string;
}): Promise<DeckBuildReading> {
  const data = await dataOf<{ buildId: string; state: DeckBuildState }>(
    await fetch('/api/deck-builder/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    'Could not start building the deck',
  );
  return { id: data.buildId, state: data.state };
}

/**
 * Reads an outline or build.
 *
 * @throws DeckWorkGoneError when it is no longer stored.
 */
export async function readDeckWork<
  Reading extends DeckOutlineReading | DeckBuildReading,
>(id: string, signal?: AbortSignal): Promise<Reading> {
  return dataOf<Reading>(
    await fetch(`/api/deck-builder/${encodeURIComponent(id)}`, { signal }),
    'Could not read the deck work',
  );
}

/** Asks an outline or build to stop; returns it as it stands. */
export async function stopDeckWork<
  Reading extends DeckOutlineReading | DeckBuildReading,
>(id: string): Promise<Reading> {
  return dataOf<Reading>(
    await fetch(`/api/deck-builder/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    }),
    'Could not stop the deck work',
  );
}

/** Deletes an outline or build. One already gone is fine. */
export async function removeDeckWork(id: string): Promise<void> {
  try {
    await dataOf(
      await fetch(`/api/deck-builder/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
      'Could not remove the deck work',
    );
  } catch (error) {
    if (!(error instanceof DeckWorkGoneError)) throw error;
  }
}
