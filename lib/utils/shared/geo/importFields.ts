/**
 * The field vocabulary for importing locations from GeoJSON, KML and tabular
 * files — one table that everything else is derived from.
 *
 * Column auto-detection, validation, the in-app field guide and the
 * downloadable template are all generated from `IMPORT_FIELDS`, so there is
 * no second place for them to drift from what the importer actually accepts.
 * Canonical names are the CSV export's own headers: a file this app exported
 * re-imports without a mapping step, and that round-trip is the contract.
 *
 * GeoJSON needs the vocabulary as much as CSV does — its `properties` are
 * just columns under another name, and the same aliases apply to them.
 *
 * Client-safe: no imports beyond types.
 */
import {
  EventPrecision,
  MapFeatureConfidence,
  MapFeatureGranularity,
  MapFeatureProminence,
} from '@/types/workflow';

export type ImportFieldKey =
  | 'name'
  | 'lat'
  | 'lon'
  | 'coordinates'
  | 'description'
  | 'category'
  | 'event_start'
  | 'event_end'
  | 'event_precision'
  | 'event_ongoing'
  | 'granularity'
  | 'approx_radius_km'
  | 'prominence'
  | 'confidence'
  | 'confidence_reason'
  | 'country_code'
  | 'parent'
  | 'source'
  | 'source_url';

export type ImportFieldType = 'text' | 'number' | 'enum' | 'date' | 'boolean';

export interface ImportField {
  key: ImportFieldKey;
  /**
   * Header and property names accepted for this field. Matching is
   * case-insensitive and ignores spaces, hyphens and underscores, so
   * "Country Code", "country-code" and "COUNTRY_CODE" all resolve.
   */
  aliases: readonly string[];
  required: boolean;
  type: ImportFieldType;
  enumValues?: readonly string[];
  /** One-line meaning, shown in the field guide. */
  description: string;
  /** Value used for the template's example row. */
  example: string;
}

export const CONFIDENCE_VALUES: readonly MapFeatureConfidence[] = [
  'high',
  'medium',
  'low',
];
export const PROMINENCE_VALUES: readonly MapFeatureProminence[] = [
  'primary',
  'secondary',
  'mention',
];
export const GRANULARITY_VALUES: readonly MapFeatureGranularity[] = [
  'site',
  'city',
  'district',
  'region',
  'country',
];
export const PRECISION_VALUES: readonly EventPrecision[] = [
  'minute',
  'hour',
  'day',
  'month',
  'year',
];

export const IMPORT_FIELDS: readonly ImportField[] = [
  {
    key: 'name',
    aliases: ['name', 'title', 'label', 'place', 'location_name', 'site'],
    required: true,
    type: 'text',
    description: 'What the place is called. Must not be empty.',
    example: 'Goma field hospital',
  },
  {
    key: 'lat',
    aliases: ['lat', 'latitude', 'y'],
    required: true,
    type: 'number',
    description: 'Latitude in decimal degrees, −90 to 90.',
    example: '-1.6585',
  },
  {
    key: 'lon',
    aliases: ['lon', 'lng', 'long', 'longitude', 'x'],
    required: true,
    type: 'number',
    description: 'Longitude in decimal degrees, −180 to 180.',
    example: '29.2205',
  },
  {
    // Satisfies lat + lon together; never appears in the template because
    // the two separate columns are the clearer contract.
    key: 'coordinates',
    aliases: [
      'coordinates',
      'coords',
      'latlon',
      'lat_lon',
      'location',
      'geometry',
      'wkt',
    ],
    required: false,
    type: 'text',
    description:
      'Instead of separate lat/lon columns: "lat, lon", GeoJSON geometry, or WKT POINT(lon lat).',
    example: '',
  },
  {
    key: 'description',
    aliases: ['description', 'notes', 'summary', 'details'],
    required: false,
    type: 'text',
    description: 'Free text shown with the point.',
    example: 'Opened March 2024; 40 beds.',
  },
  {
    key: 'category',
    aliases: ['category', 'type', 'kind', 'tag', 'class'],
    required: false,
    type: 'text',
    description: 'Free text; the legend groups points by it.',
    example: 'Health facility',
  },
  {
    key: 'event_start',
    aliases: ['event_start', 'start', 'date', 'from', 'start_date', 'begin'],
    required: false,
    type: 'date',
    description:
      'When it happened or began: YYYY, YYYY-MM, YYYY-MM-DD, or an ISO date-time. Precision is taken from the shape.',
    example: '2024-03-12',
  },
  {
    key: 'event_end',
    aliases: ['event_end', 'end', 'to', 'until', 'end_date', 'finish'],
    required: false,
    type: 'date',
    description: 'When it ended, in the same forms. Leave empty if not stated.',
    example: '',
  },
  {
    key: 'event_precision',
    aliases: ['event_precision', 'precision', 'date_precision'],
    required: false,
    type: 'enum',
    enumValues: PRECISION_VALUES,
    description:
      'How finely the date is known; inferred from the date when absent.',
    example: 'day',
  },
  {
    key: 'event_ongoing',
    aliases: ['event_ongoing', 'ongoing', 'active', 'current'],
    required: false,
    type: 'boolean',
    description: 'true / yes / 1 when the event has no end yet.',
    example: 'false',
  },
  {
    key: 'granularity',
    aliases: ['granularity', 'level', 'scale'],
    required: false,
    type: 'enum',
    enumValues: GRANULARITY_VALUES,
    description:
      'site and city are drawn as pins; district, region and country as extent circles.',
    example: 'site',
  },
  {
    key: 'approx_radius_km',
    aliases: ['approx_radius_km', 'radius_km', 'radius', 'extent_km'],
    required: false,
    type: 'number',
    description: 'Extent of an area in kilometres; 0 for a point.',
    example: '0',
  },
  {
    key: 'prominence',
    aliases: ['prominence', 'importance', 'weight'],
    required: false,
    type: 'enum',
    enumValues: PROMINENCE_VALUES,
    description: 'How central the place is to the material.',
    example: 'primary',
  },
  {
    key: 'confidence',
    aliases: ['confidence', 'certainty', 'accuracy'],
    required: false,
    type: 'enum',
    enumValues: CONFIDENCE_VALUES,
    description:
      'How sure you are of the coordinates. Absent: the default chosen at import.',
    example: 'high',
  },
  {
    key: 'confidence_reason',
    aliases: ['confidence_reason', 'confidence_note', 'reason'],
    required: false,
    type: 'text',
    description: 'Why that confidence — e.g. "GPS reading" or "town centroid".',
    example: 'GPS reading',
  },
  {
    key: 'country_code',
    aliases: ['country_code', 'iso', 'iso2', 'iso_a2', 'countrycode', 'cc'],
    required: false,
    type: 'text',
    description:
      'ISO 3166-1 alpha-2 (e.g. CD). A country name is not guessed from.',
    example: 'CD',
  },
  {
    key: 'parent',
    aliases: ['parent', 'parent_name', 'region_name', 'admin1', 'province'],
    required: false,
    type: 'text',
    description:
      'The broader place this belongs to, usually a country or region.',
    example: 'North Kivu',
  },
  {
    key: 'source',
    aliases: ['source', 'origin', 'reference'],
    required: false,
    type: 'text',
    description: 'Where the row came from. Absent: the file name.',
    example: 'Field team survey',
  },
  {
    key: 'source_url',
    aliases: ['source_url', 'url', 'link', 'href'],
    required: false,
    type: 'text',
    description: 'A link for the source, if any.',
    example: '',
  },
];

export const REQUIRED_FIELD_KEYS: readonly ImportFieldKey[] =
  IMPORT_FIELDS.filter((f) => f.required).map((f) => f.key);

/** Header normalisation: case, spaces, hyphens and underscores all fold. */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, '');
}

const ALIAS_INDEX: ReadonlyMap<string, ImportFieldKey> = (() => {
  const index = new Map<string, ImportFieldKey>();
  for (const field of IMPORT_FIELDS) {
    for (const alias of field.aliases)
      index.set(normalizeHeader(alias), field.key);
  }
  return index;
})();

/** The field a header or property name means, or null when it means nothing. */
export function fieldForHeader(header: string): ImportFieldKey | null {
  return ALIAS_INDEX.get(normalizeHeader(header)) ?? null;
}

/** A column-to-field mapping: which source header feeds each field. */
export type ImportMapping = Partial<Record<ImportFieldKey, string>>;

export interface DetectedMapping {
  mapping: ImportMapping;
  /** Headers that resolved to no field; reported, never silently dropped. */
  unmapped: string[];
  /** Fields two or more headers both claimed; the first wins, the rest are listed. */
  ambiguous: Partial<Record<ImportFieldKey, string[]>>;
}

/**
 * Maps headers to fields by alias, first header wins. Ambiguity is returned
 * rather than resolved: two columns that both look like `lat` is a question
 * for the person, not a coin toss.
 */
export function detectMapping(headers: readonly string[]): DetectedMapping {
  const mapping: ImportMapping = {};
  const unmapped: string[] = [];
  const ambiguous: Partial<Record<ImportFieldKey, string[]>> = {};
  for (const header of headers) {
    const key = fieldForHeader(header);
    if (!key) {
      unmapped.push(header);
      continue;
    }
    if (mapping[key] === undefined) {
      mapping[key] = header;
    } else {
      (ambiguous[key] ??= []).push(header);
    }
  }
  return { mapping, unmapped, ambiguous };
}

/**
 * True when the mapping can place a row. Geometry files (GeoJSON, KML) carry
 * position on every row already, and a feature there with no name property
 * is common and gets numbered — so for them nothing is required of the
 * columns. A spreadsheet must name its points and say where they are.
 */
export function mappingHasRequired(
  mapping: ImportMapping,
  hasGeometry = false,
): boolean {
  if (hasGeometry) return true;
  if (!mapping.name) return false;
  return (!!mapping.lat && !!mapping.lon) || !!mapping.coordinates;
}

/** The required fields a mapping still lacks, in guide order. */
export function missingRequired(
  mapping: ImportMapping,
  hasGeometry = false,
): ImportFieldKey[] {
  if (hasGeometry) return [];
  const missing: ImportFieldKey[] = [];
  if (!mapping.name) missing.push('name');
  if (!mapping.coordinates) {
    if (!mapping.lat) missing.push('lat');
    if (!mapping.lon) missing.push('lon');
  }
  return missing;
}

/** Fields that appear in the template: everything except the combined column. */
export const TEMPLATE_FIELDS: readonly ImportField[] = IMPORT_FIELDS.filter(
  (f) => f.key !== 'coordinates',
);

/**
 * The downloadable template: canonical headers and one example row. Built
 * from the same table as the guide and the detector, so it cannot describe
 * a file the importer would then refuse.
 */
export function buildTemplateCsv(): string {
  const escape = (value: string) =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const header = TEMPLATE_FIELDS.map((f) => f.key).join(',');
  const example = TEMPLATE_FIELDS.map((f) => escape(f.example)).join(',');
  return `${header}\n${example}\n`;
}
