/**
 * How a multi-step search's state travels between turns.
 *
 * The server is stateless, so the state rides on the assistant message the
 * way citations do — inside the `arguments` of one extra tool record (the
 * search's outcome line in the "Used N tools" strip), which the client
 * persists with the message and echoes back on the next request. The
 * client reads the same record to offer "Keep searching" on a search that
 * ended short; the server reads it to continue that search
 * (docs/WEB_SEARCH_DEAD_END_PROPOSAL.md §E).
 *
 * Shared (no server-only imports): the client renders from it, the
 * enricher parses it.
 */
import { z } from 'zod';

export const SEARCH_STATE_RECORD_NAME = 'web_search';
export const SEARCH_STATE_RECORD_LABEL = 'Web Search (outcome)';

export const SEARCH_OUTCOMES = [
  'answered',
  'ask_user',
  'gave_up',
  'degraded',
  'limit',
  'unassessed',
] as const;

/** Outcomes after which the user may ask to keep looking. */
export const CONTINUABLE_OUTCOMES: ReadonlyArray<
  (typeof SEARCH_OUTCOMES)[number]
> = ['gave_up', 'degraded', 'limit'];

const strategySchema = z.enum([
  'phrase',
  'entity',
  'venue',
  'terms',
  'language',
]);

/** Bounded: it is echoed by the client and parsed on the server. */
export const SearchStateSchema = z.object({
  question: z.string().max(1500),
  queries: z.array(z.string().max(300)).max(20),
  strategies: z.array(strategySchema).max(5),
  deadEndStrategies: z.array(strategySchema).max(5),
  pagesTried: z.array(z.string().max(2000)).max(10),
  outcome: z.enum(SEARCH_OUTCOMES),
  reason: z.string().max(300),
  steps: z
    .array(
      z.object({
        kind: z.enum(['search', 'read']),
        detail: z.string().max(400),
        outcome: z.string().max(200),
      }),
    )
    .max(12),
});
export type SearchState = z.infer<typeof SearchStateSchema>;

/** The `arguments` string of the outcome record. */
export function encodeSearchState(state: SearchState): string {
  return JSON.stringify({ searchState: state });
}

/** The state carried by a tool record, if it is the outcome record. */
export function decodeSearchState(record: {
  name?: string;
  arguments?: string | null;
}): SearchState | null {
  if (record.name !== SEARCH_STATE_RECORD_NAME || !record.arguments) {
    return null;
  }
  try {
    const parsed = JSON.parse(record.arguments) as { searchState?: unknown };
    const result = SearchStateSchema.safeParse(parsed.searchState);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Whether the search this record describes can be continued. */
export function isContinuableSearchState(state: SearchState | null): boolean {
  return state !== null && CONTINUABLE_OUTCOMES.includes(state.outcome);
}
