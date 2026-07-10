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
    eventStart: {
      type: 'string',
      description:
        'When the event/situation at this place began or occurred, ONLY if the material states it: "YYYY-MM-DD", "YYYY-MM", or "YYYY" matching the material\'s precision — never invent finer precision than the material gives. Empty string when the material gives no date.',
    },
    eventEnd: {
      type: 'string',
      description:
        'When it ended, same format and rules; empty string for point events, ongoing situations, or unknown.',
    },
    eventOngoing: {
      type: 'boolean',
      description:
        'true when the material indicates the situation began and is still continuing (e.g. "since March", "remains closed")',
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
    'eventStart',
    'eventEnd',
    'eventOngoing',
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
- Event dates come ONLY from the material, at the material's own precision ("early 2026" → "2026"; "March" with a known year → "YYYY-03"). Resolve relative phrases ("last Tuesday") only when the material anchors them to a date; otherwise use coarser precision or leave empty. eventOngoing means started and not ended.
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
