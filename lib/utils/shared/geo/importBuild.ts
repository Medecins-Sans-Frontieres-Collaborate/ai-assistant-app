/**
 * Validating parsed rows into map features.
 *
 * Nothing is inferred and nothing is guessed. A row either has usable
 * coordinates or it is skipped with a reason; a bad optional value is
 * dropped from that row with a note, never repaired into something the file
 * did not say. Every decision that changes data — a swapped coordinate pair,
 * an area reduced to its centre, a numbered nameless point — is counted so
 * the summary can state it.
 *
 * Confidence is a stated fact here, not a model's certainty: a file that
 * carries coordinates asserts them. So absent a `confidence` column the
 * caller's chosen default applies (and can be changed per row afterwards),
 * with a reason naming the file as provenance.
 *
 * Client-safe.
 */
import {
  eventRangeFromLegacy,
  formatEventInstant,
  isEventPrecision,
  normalizeEventRange,
} from '@/lib/utils/shared/date/eventRange';
import { parsePartialDate } from '@/lib/utils/shared/date/partialDate';
import { isValidCoordinate } from '@/lib/utils/shared/geo/geojson';
import { LonLat } from '@/lib/utils/shared/geo/geometry';
import {
  CONFIDENCE_VALUES,
  GRANULARITY_VALUES,
  ImportFieldKey,
  ImportMapping,
  PROMINENCE_VALUES,
} from '@/lib/utils/shared/geo/importFields';
import { ParsedImport, RawImportRow } from '@/lib/utils/shared/geo/importParse';

import {
  EventPrecision,
  EventRange,
  MapFeature,
  MapFeatureConfidence,
  MapFeatureGranularity,
  MapFeatureProminence,
} from '@/types/workflow';

/** A validated feature, not yet given a workspace id or source. */
export type ImportedFeature = Omit<MapFeature, 'id' | 'sourceId'> & {
  /** Source row, for per-row edits in the preview and for messages. */
  rowIndex: number;
};

export type SkipReason =
  | 'no_coordinates'
  | 'invalid_coordinates'
  | 'projected_coordinates'
  | 'duplicate'
  | 'capped';

export interface SkippedRow {
  rowIndex: number;
  reason: SkipReason;
}

export interface ImportStats {
  imported: number;
  skipped: Record<SkipReason, number>;
  /** Rows whose lat/lon looked transposed and were swapped. */
  swapped: number;
  /** Rows positioned at the centre of a shape rather than a stated point. */
  approximated: number;
  /** Rows that had no name and were numbered. */
  unnamed: number;
  /** Rows whose event dates could not be read and were imported undated. */
  undated: number;
  /** Optional cells that were not in the field's vocabulary and were dropped. */
  droppedValues: number;
  /** Headers that resolved to no field and were not read. */
  ignoredHeaders: string[];
}

export interface ImportBuildOptions {
  mapping: ImportMapping;
  /** Applied when the row carries no usable `confidence` of its own. */
  defaultConfidence: MapFeatureConfidence;
  /** Provenance for `confidenceReason` and the default `source`. */
  sourceName: string;
  /** Features already on the map, for exact-duplicate skipping. */
  existing?: readonly Pick<MapFeature, 'name' | 'lat' | 'lon'>[];
  /** How many more features the destination can take; rows past it are counted as capped. */
  capacity?: number;
}

export interface ImportBuildResult {
  features: ImportedFeature[];
  skipped: SkippedRow[];
  stats: ImportStats;
}

/* ------------------------------------------------------------------ */
/* Cell coercion                                                       */
/* ------------------------------------------------------------------ */

function cell(
  row: RawImportRow,
  mapping: ImportMapping,
  key: ImportFieldKey,
): unknown {
  const header = mapping[key];
  return header === undefined ? undefined : row.values[header];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** Accepts "1.5", "1,5" (decimal comma), " -1.66 "; rejects everything else. */
export function parseNumberCell(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = text(value);
  if (!s) return null;
  const normalized = /^-?\d+,\d+$/.test(s) ? s.replace(',', '.') : s;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseBooleanCell(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const s = text(value).toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0', ''].includes(s)) return false;
  return null;
}

function parseEnumCell<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  const s = text(value).toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
}

/**
 * A combined coordinates cell: "lat, lon" / "lat lon", a GeoJSON geometry
 * (object or JSON text), or WKT `POINT(lon lat)`. Returns [lon, lat].
 */
export function parseCoordinatesCell(value: unknown): LonLat | null {
  if (value && typeof value === 'object') {
    const geom = value as { type?: unknown; coordinates?: unknown };
    if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
      const [lon, lat] = geom.coordinates.map(Number);
      return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
    }
    return null;
  }
  const s = text(value);
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      return parseCoordinatesCell(JSON.parse(s));
    } catch {
      return null;
    }
  }
  const wkt = /^POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(s);
  if (wkt) {
    const lon = Number(wkt[1]);
    const lat = Number(wkt[2]);
    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
  }
  const parts = s
    .split(/[,\s;]+/)
    .filter(Boolean)
    .map(parseNumberCell);
  if (parts.length >= 2 && parts[0] !== null && parts[1] !== null) {
    // Plain pairs are written lat first — the convention of every
    // spreadsheet, and the opposite of GeoJSON's.
    return [parts[1], parts[0]];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

interface ImportInstant {
  /** 'YYYY-MM-DDTHH:mm' UTC. */
  instant: string;
  precision: EventPrecision;
  /** For an end date given coarsely: the first instant AFTER the window. */
  exclusiveEnd: string;
}

/**
 * Reads a date cell in any of the accepted shapes. Partial dates keep the
 * precision their shape implies ("2024-03" is a month); date-times are
 * minutes. Ambiguous numeric forms like 12/03/2024 are refused rather than
 * guessed — day-first and month-first readings would both be plausible.
 */
export function parseDateCell(value: unknown): ImportInstant | null {
  const s = text(value);
  if (!s) return null;
  const partial = parsePartialDate(s);
  if (partial) {
    const range = eventRangeFromLegacy({ eventStart: s, eventEnd: s });
    if (!range || !range.end) return null;
    return {
      instant: range.start,
      precision: partial.precision,
      exclusiveEnd: range.end,
    };
  }
  // ISO date-time with a T (and optional seconds / zone).
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const ms = Date.parse(
      s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`,
    );
    if (!Number.isFinite(ms)) return null;
    const instant = formatEventInstant(ms);
    return {
      instant,
      precision: 'minute',
      exclusiveEnd: formatEventInstant(ms + 60_000),
    };
  }
  return null;
}

/**
 * Builds the event range from the four timing cells. Returns undefined for
 * no timing at all, null when timing was present but unreadable (counted as
 * undated with a note), else the range.
 */
export function buildEventRange(
  startRaw: unknown,
  endRaw: unknown,
  precisionRaw: unknown,
  ongoingRaw: unknown,
): EventRange | null | undefined {
  const hasAny = [startRaw, endRaw].some((v) => text(v) !== '');
  if (!hasAny) return undefined;
  const start = parseDateCell(startRaw);
  const end = parseDateCell(endRaw);
  if (!start && !end) return null;
  const explicitPrecision = isEventPrecision(text(precisionRaw).toLowerCase())
    ? (text(precisionRaw).toLowerCase() as EventPrecision)
    : undefined;
  const ongoing = parseBooleanCell(ongoingRaw) === true;
  return normalizeEventRange({
    start: (start ?? end)!.instant,
    end: end ? end.exclusiveEnd : null,
    precision:
      explicitPrecision ??
      (end && start
        ? coarser(start.precision, end.precision)
        : (start ?? end)!.precision),
    ongoing: ongoing && !end,
  });
}

const COARSENESS: Record<EventPrecision, number> = {
  minute: 0,
  hour: 1,
  day: 2,
  month: 3,
  year: 4,
};
function coarser(a: EventPrecision, b: EventPrecision): EventPrecision {
  return COARSENESS[a] >= COARSENESS[b] ? a : b;
}

/* ------------------------------------------------------------------ */
/* Position                                                            */
/* ------------------------------------------------------------------ */

type PositionOutcome =
  | { ok: true; lat: number; lon: number; swapped: boolean }
  | {
      ok: false;
      reason:
        | 'no_coordinates'
        | 'invalid_coordinates'
        | 'projected_coordinates';
    };

/**
 * Where a row is. Geometry outranks columns. Column pairs get one heuristic:
 * a value that cannot be a latitude but can be a longitude, next to one that
 * can be a latitude, is a transposed pair — swapped, and counted so the
 * summary says so. Values far outside both ranges are projected metres, not
 * degrees, and are refused rather than plotted somewhere absurd.
 */
function positionOf(
  row: RawImportRow,
  mapping: ImportMapping,
): PositionOutcome {
  if (row.lonLat) {
    const [lon, lat] = row.lonLat;
    return isValidCoordinate(lat, lon)
      ? { ok: true, lat, lon, swapped: false }
      : { ok: false, reason: 'invalid_coordinates' };
  }
  let lat: number | null = null;
  let lon: number | null = null;
  if (mapping.lat && mapping.lon) {
    lat = parseNumberCell(cell(row, mapping, 'lat'));
    lon = parseNumberCell(cell(row, mapping, 'lon'));
  }
  if ((lat === null || lon === null) && mapping.coordinates) {
    const pair = parseCoordinatesCell(cell(row, mapping, 'coordinates'));
    if (pair) [lon, lat] = pair;
  }
  if (lat === null || lon === null)
    return { ok: false, reason: 'no_coordinates' };
  if (Math.abs(lat) > 180 && Math.abs(lon) > 180) {
    return { ok: false, reason: 'projected_coordinates' };
  }
  if (isValidCoordinate(lat, lon))
    return { ok: true, lat, lon, swapped: false };
  if (
    Math.abs(lat) > 90 &&
    Math.abs(lon) <= 90 &&
    isValidCoordinate(lon, lat)
  ) {
    return { ok: true, lat: lon, lon: lat, swapped: true };
  }
  return { ok: false, reason: 'invalid_coordinates' };
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

function duplicateKey(name: string, lat: number, lon: number): string {
  return `${name.normalize('NFKC').trim().toLowerCase()}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
}

export function buildImport(
  parsed: ParsedImport,
  options: ImportBuildOptions,
): ImportBuildResult {
  const { mapping, defaultConfidence, sourceName } = options;
  const features: ImportedFeature[] = [];
  const skipped: SkippedRow[] = [];
  const stats: ImportStats = {
    imported: 0,
    skipped: {
      no_coordinates: 0,
      invalid_coordinates: 0,
      projected_coordinates: 0,
      duplicate: 0,
      capped: 0,
    },
    swapped: 0,
    approximated: 0,
    unnamed: 0,
    undated: 0,
    droppedValues: 0,
    ignoredHeaders: parsed.headers.filter(
      (h) => !Object.values(mapping).includes(h),
    ),
  };
  const seen = new Set<string>();
  for (const existing of options.existing ?? []) {
    seen.add(duplicateKey(existing.name, existing.lat, existing.lon));
  }
  const capacity = options.capacity ?? Infinity;

  const skip = (row: RawImportRow, reason: SkipReason) => {
    skipped.push({ rowIndex: row.index, reason });
    stats.skipped[reason] += 1;
  };

  for (const row of parsed.rows) {
    const position = positionOf(row, mapping);
    if (!position.ok) {
      skip(row, position.reason);
      continue;
    }

    let name = text(cell(row, mapping, 'name'));
    if (!name) {
      name = `Point ${row.index}`;
      stats.unnamed += 1;
    }

    const key = duplicateKey(name, position.lat, position.lon);
    if (seen.has(key)) {
      skip(row, 'duplicate');
      continue;
    }
    if (features.length >= capacity) {
      skip(row, 'capped');
      continue;
    }
    seen.add(key);
    if (position.swapped) stats.swapped += 1;

    // Optional vocabulary cells: a value outside the vocabulary is dropped,
    // not coerced into the nearest legal one.
    const confidence = parseEnumCell<MapFeatureConfidence>(
      cell(row, mapping, 'confidence'),
      CONFIDENCE_VALUES,
    );
    if (text(cell(row, mapping, 'confidence')) && !confidence)
      stats.droppedValues += 1;
    const prominence = parseEnumCell<MapFeatureProminence>(
      cell(row, mapping, 'prominence'),
      PROMINENCE_VALUES,
    );
    if (text(cell(row, mapping, 'prominence')) && !prominence)
      stats.droppedValues += 1;
    let granularity = parseEnumCell<MapFeatureGranularity>(
      cell(row, mapping, 'granularity'),
      GRANULARITY_VALUES,
    );
    if (text(cell(row, mapping, 'granularity')) && !granularity)
      stats.droppedValues += 1;
    let radiusKm = parseNumberCell(cell(row, mapping, 'approx_radius_km'));
    if (radiusKm !== null && radiusKm < 0) radiusKm = null;

    // A shape reduced to its centre: the radius is the shape's, and it is
    // drawn as an extent so a country outline never masquerades as a pin.
    if (row.geometry === 'area' || row.geometry === 'line') {
      stats.approximated += 1;
      if (radiusKm === null)
        radiusKm = Math.round((row.radiusKm ?? 0) * 10) / 10;
      if (!granularity) granularity = radiusKm > 50 ? 'region' : 'district';
    }
    if (!granularity)
      granularity = radiusKm && radiusKm > 0 ? 'district' : 'site';

    const range = buildEventRange(
      cell(row, mapping, 'event_start'),
      cell(row, mapping, 'event_end'),
      cell(row, mapping, 'event_precision'),
      cell(row, mapping, 'event_ongoing'),
    );
    if (range === null) stats.undated += 1;

    const reason = text(cell(row, mapping, 'confidence_reason'));
    const countryCode = text(cell(row, mapping, 'country_code')).toUpperCase();

    features.push({
      rowIndex: row.index,
      name,
      description: text(cell(row, mapping, 'description')),
      lat: position.lat,
      lon: position.lon,
      confidence: confidence ?? defaultConfidence,
      confidenceReason: reason || `Imported from ${sourceName}`,
      category: text(cell(row, mapping, 'category')),
      ...(range ? { event: range } : {}),
      prominence: prominence ?? 'primary',
      granularity,
      countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : '',
      parentName: text(cell(row, mapping, 'parent')),
      approxRadiusKm: radiusKm ?? 0,
    });
  }
  stats.imported = features.length;
  return { features, skipped, stats };
}
