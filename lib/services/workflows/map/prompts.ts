/**
 * Prompt + schema for the map workflow's geocoding-by-model-knowledge
 * extraction. No external geocoding API is called — coordinates come from
 * the model, so confidence marking is mandatory and the UI shows a
 * "verify before operational use" disclaimer.
 */

/**
 * Per-feature schema, exported separately so the map chat's mutation
 * schema (`addFeatures`) reuses exactly the same shape.
 */
export const MAP_FEATURE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: {
      type: 'string',
      description: 'What the material says about this place (may be empty)',
    },
    lat: { type: 'number' },
    lon: { type: 'number' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    confidenceReason: {
      type: 'string',
      description: 'Why confidence is not high (empty when high)',
    },
    category: {
      type: 'string',
      description:
        'Short category, e.g. city, hospital, camp, region, incident',
    },
    prominence: {
      type: 'string',
      enum: ['primary', 'secondary', 'mention'],
      description:
        'How central the place is to the material: primary = the material is substantially about it; secondary = plays a real supporting role; mention = referenced only in passing',
    },
    granularity: {
      type: 'string',
      enum: ['site', 'city', 'district', 'region', 'country'],
      description:
        'Spatial granularity: site = a specific facility/point (hospital, camp, office); city = a city/town/village; district = a sub-regional admin area; region = a state/province/large region; country = a whole country',
    },
    countryCode: {
      type: 'string',
      description:
        'ISO 3166-1 alpha-2 code of the country containing this place (the country itself for country granularity); empty string when unknown or not applicable',
    },
    parentName: {
      type: 'string',
      description:
        'Name of the broader place this belongs to as used in the material (usually the country or region); empty string when none',
    },
    approxRadiusKm: {
      type: 'number',
      description:
        'Approximate radius in kilometres covering the extent of the place, for district/region/country granularity (e.g. a small country ~150, a large region ~300); 0 for site and city',
    },
    event: {
      type: 'object',
      description:
        'When the event/situation at this place happened, ONLY if the material states it. Always a range, always written to the minute; `precision` records how finely the material actually put it, so widen the range to match rather than inventing detail.',
      properties: {
        start: {
          type: 'string',
          description:
            'UTC start instant "YYYY-MM-DDTHH:mm", padded to the beginning of whatever the material stated ("March 2026" → "2026-03-01T00:00"; "1812" → "1812-01-01T00:00"; "14:30 on 12 March 2026" → "2026-03-12T14:30"). Empty string when the material gives no date at all.',
        },
        end: {
          type: 'string',
          description:
            'UTC instant the event STOPPED, same format, exclusive (the first moment no longer covered: an event ending 3 March is "2026-03-04T00:00"). Empty string unless the material says it ended — a one-off event or an unknown end is an empty string, NOT a guess.',
        },
        precision: {
          type: 'string',
          enum: ['minute', 'hour', 'day', 'month', 'year'],
          description:
            'How precisely the material stated the timing: "1812" → year, "March 2026" → month, "12 March" → day, "around 14:00" → hour, "14:30" → minute. Never claim finer precision than the material gives.',
        },
        ongoing: {
          type: 'boolean',
          description:
            'true when the material indicates the situation began and is still continuing (e.g. "since March", "remains closed")',
        },
      },
      required: ['start', 'end', 'precision', 'ongoing'],
      additionalProperties: false,
    },
  },
  required: [
    'name',
    'description',
    'lat',
    'lon',
    'confidence',
    'confidenceReason',
    'category',
    'prominence',
    'granularity',
    'countryCode',
    'parentName',
    'approxRadiusKm',
    'event',
  ],
  additionalProperties: false,
} as const;

/** Relationship between two extracted places, referenced by name. */
export const MAP_CONNECTION_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    fromName: {
      type: 'string',
      description: 'Name of the origin place, exactly as listed in features',
    },
    toName: {
      type: 'string',
      description: 'Name of the destination/related place, exactly as listed',
    },
    kind: {
      type: 'string',
      description:
        'Short relationship kind, e.g. movement, supply-line, causal, deployment, reference',
    },
    description: {
      type: 'string',
      description: 'One sentence describing the relationship per the material',
    },
  },
  required: ['fromName', 'toName', 'kind', 'description'],
  additionalProperties: false,
} as const;

export const MAP_FEATURES_SCHEMA = {
  type: 'object',
  properties: {
    features: {
      type: 'array',
      items: MAP_FEATURE_ITEM_SCHEMA,
    },
    connections: {
      type: 'array',
      description:
        'Relationships between the extracted places that the material states (empty when none)',
      items: MAP_CONNECTION_ITEM_SCHEMA,
    },
  },
  required: ['features', 'connections'],
  additionalProperties: false,
} as const;

export function buildMapSystemPrompt(): string {
  return `You identify geographic locations in material and geocode them from your knowledge.

Rules:
- Extract every distinct place the material names or clearly implies.
- Coordinates come from your knowledge of the world. NEVER guess precise coordinates for ambiguous or unknown places — use the settlement or admin-area centroid and mark confidence "low" or "medium" with the reason (e.g. "several towns named X in country Y").
- confidence "high" only for unambiguous, well-known places.
- Points only. For areas (districts, countries), use the centroid and say so in confidenceReason.
- Do not invent places that are not supported by the material.
- Judge each location's prominence honestly. "primary" is reserved for places the material is substantially about; "secondary" for places with a real supporting role; "mention" for places referenced only in passing (a single aside about operations elsewhere is "mention", however far away it is). Material genuinely about several places has several primaries; material about one place with scattered asides has one primary and mentions.
- Classify granularity by what the place IS, not how it's used: a named facility is "site", a settlement of any size is "city", administrative areas scale up through "district", "region", "country". For district/region/country give an approxRadiusKm that roughly covers the area's extent from its centroid.
- Set parentName to the containing country or region when the material makes it clear (so container features can be linked); always fill countryCode when the country is known.
- Event timing comes ONLY from the material. Set event.precision to how finely the material stated it and widen event.start/event.end to match — "early 2026" is precision "year" starting "2026-01-01T00:00", not a guessed month. Fill event.end only when the material says the event ended; a one-off event leaves it empty (it happened, that is all we know). Resolve relative phrases ("last Tuesday") only when the material anchors them to a date; otherwise go coarser, or leave event.start empty. event.ongoing means started and not ended.
- Report connections the material STATES between extracted places: movement of people or teams, cause and effect, supply or deployment lines, coordination links, and historical references ("like the 2023 earthquakes in Syria"). Use the exact feature names in fromName/toName. Never invent relationships; an empty connections list is normal.`;
}

export function buildMapUserPrompt(
  sourceText: string,
  existingNames: string[],
  instructions?: string,
): string {
  const dedupe =
    existingNames.length > 0
      ? `\n\nAlready mapped (do NOT repeat these): ${existingNames.join(', ')}`
      : '';
  return `Identify and geocode the locations in this material.${
    instructions ? `\nGuidance: ${instructions}` : ''
  }${dedupe}

Material:
"""
${sourceText}
"""`;
}
