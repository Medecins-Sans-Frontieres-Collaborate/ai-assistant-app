import { MAP_CONNECTION_ITEM_SCHEMA, MAP_FEATURE_ITEM_SCHEMA } from './prompts';

/**
 * Prompts and digest building for the map-aware chat rail
 * (`/api/workflows/map/chat`). The digest travels inline per request —
 * the server holds no map state.
 */

/**
 * The streamed answer ends with this exact token (own line) iff the user
 * asked to change the map; the route strips it and triggers the
 * structured mutations call. Never shown to users.
 */
export const MAP_EDIT_SENTINEL = '[[MAP_EDIT]]';

/** Compact per-feature record the client sends (description pre-truncated). */
export interface CompactMapFeature {
  name: string;
  lat: number;
  lon: number;
  category: string;
  granularity: string;
  prominence: string;
  confidence: string;
  countryCode?: string;
  eventStart?: string;
  eventEnd?: string;
  eventOngoing?: boolean;
  description: string;
}

/** Full detail lines for the most important features. */
const FULL_LINE_LIMIT = 400;

const PROMINENCE_ORDER: Record<string, number> = {
  primary: 0,
  secondary: 1,
  mention: 2,
};

function dateSpan(f: CompactMapFeature): string {
  if (!f.eventStart && !f.eventEnd && !f.eventOngoing) return '';
  return `${f.eventStart ?? ''}${f.eventOngoing ? '..ongoing' : f.eventEnd ? `..${f.eventEnd}` : ''}`;
}

function fullLine(f: CompactMapFeature): string {
  return [
    f.name,
    f.granularity,
    f.category,
    f.countryCode ?? '',
    `${f.lat.toFixed(2)},${f.lon.toFixed(2)}`,
    dateSpan(f),
    `${f.prominence}/${f.confidence}`,
    f.description,
  ].join('|');
}

function indexLine(f: CompactMapFeature): string {
  return `${f.name}|${f.category}|${f.lat.toFixed(2)},${f.lon.toFixed(2)}`;
}

/**
 * Tiered digest: header aggregates (always), full lines for the top
 * features (prominence first, then dated-recent), index lines for the
 * rest. The route applies the final token bound via truncateToTokenBudget
 * — this builder orders content so a cut loses the least important tail
 * and the header always states what's omitted.
 */
export function buildMapDigest(features: CompactMapFeature[]): string {
  const byCategory = new Map<string, number>();
  let earliest = '';
  let latest = '';
  for (const f of features) {
    const key = f.category.trim().toLowerCase() || '(uncategorized)';
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
    for (const d of [f.eventStart, f.eventEnd]) {
      if (!d) continue;
      if (!earliest || d < earliest) earliest = d;
      if (!latest || d > latest) latest = d;
    }
  }

  const ordered = [...features].sort((a, b) => {
    const p =
      (PROMINENCE_ORDER[a.prominence] ?? 1) -
      (PROMINENCE_ORDER[b.prominence] ?? 1);
    if (p !== 0) return p;
    // Dated-recent first within a prominence tier.
    return (b.eventStart ?? '').localeCompare(a.eventStart ?? '');
  });

  const full = ordered.slice(0, FULL_LINE_LIMIT);
  const rest = ordered.slice(FULL_LINE_LIMIT);

  const categorySummary = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `${category}: ${count}`)
    .join(', ');

  const header = [
    `MAPPED DATA: ${features.length} locations.`,
    `Categories: ${categorySummary || 'none'}.`,
    earliest ? `Date range: ${earliest} to ${latest}.` : 'No event dates.',
    rest.length > 0
      ? `NOTE: only the ${full.length} most important locations carry full detail below; ${rest.length} more appear as name|category|coords index lines. State this incompleteness when relevant.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const fullBlock =
    full.length > 0
      ? `\n\nLocations (name|granularity|category|country|lat,lon|dates|prominence/confidence|notes):\n${full
          .map(fullLine)
          .join('\n')}`
      : '';
  const indexBlock =
    rest.length > 0
      ? `\n\nAdditional locations (name|category|lat,lon):\n${rest
          .map(indexLine)
          .join('\n')}`
      : '';

  return `${header}${fullBlock}${indexBlock}`;
}

export function buildMapChatSystemPrompt(): string {
  return `You are the assistant inside a map workspace. The user has mapped locations/events (digest provided); you answer questions about them and can propose additions.

Rules:
- For questions about what the mapped material says, answer ONLY from the digest. If the digest notes omitted locations, say your answer may be incomplete.
- Distances: compute approximate great-circle distances from the listed coordinates and label them clearly as approximate straight-line distances (e.g. "~410 km straight-line"). Coordinates have ~1 km precision; never claim finer.
- Terrain, geography, and context questions: you may use general world knowledge, but explicitly label it as general knowledge rather than something the mapped material states.
- When an answer leans on locations marked low or medium confidence, say so.
- Keep answers concise and concrete; use the location names as they appear in the digest.
- If AND ONLY IF the user asks to change the map (add an event/location, connect events, etc.): describe what you'll add in your answer, then end your reply with the token ${MAP_EDIT_SENTINEL} alone on the final line. Never emit that token otherwise.`;
}

export function buildMapChatUserPrompt(
  digest: string,
  connections: Array<{ fromName: string; toName: string; kind: string }>,
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  const connectionBlock =
    connections.length > 0
      ? `\n\nExisting connections:\n${connections
          .map((c) => `${c.fromName} -> ${c.toName} (${c.kind})`)
          .join('\n')}`
      : '';
  const history = recentMessages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');
  return `${digest}${connectionBlock}\n\nConversation:\n\n${history}`;
}

/** Structured mutations extracted after a [[MAP_EDIT]]-flagged answer. */
export const MAP_CHAT_MUTATIONS_SCHEMA = {
  type: 'object',
  properties: {
    addFeatures: {
      type: 'array',
      description:
        'New locations/events to add to the map, as promised in the answer (empty when none)',
      items: MAP_FEATURE_ITEM_SCHEMA,
    },
    addConnections: {
      type: 'array',
      description:
        'New connections between mapped places, referenced by name (empty when none)',
      items: MAP_CONNECTION_ITEM_SCHEMA,
    },
  },
  required: ['addFeatures', 'addConnections'],
  additionalProperties: false,
} as const;

export function buildMutationsSystemPrompt(): string {
  return `You turn a map assistant's answer into structured map mutations. Extract exactly the additions the answer committed to — no more. Feature fields follow the same rules as map extraction (coordinates from your knowledge, honest confidence/prominence/granularity, dates only when stated). Connection fromName/toName must match names of mapped or newly added locations exactly.`;
}

export function buildMutationsUserPrompt(
  digest: string,
  question: string,
  answer: string,
): string {
  return `${digest}

USER REQUEST:
"""
${question}
"""

ASSISTANT ANSWER (the additions it committed to):
"""
${answer}
"""`;
}
