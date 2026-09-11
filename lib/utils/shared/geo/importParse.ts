/**
 * Turning an uploaded or pasted file into rows the importer can validate.
 *
 * Three families, one output shape:
 *  - GeoJSON: geometry is authoritative for position; `properties` become
 *    the row's columns.
 *  - KML: Placemarks, with ExtendedData and TimeStamp/TimeSpan lifted into
 *    columns under the same canonical names.
 *  - Tabular (CSV, TSV, JSON arrays, Excel already converted to CSV text):
 *    every cell is a column; position comes from mapped columns later.
 *
 * Format is sniffed from CONTENT before extension: a GeoJSON saved as
 * `.json`, or a KML saved as `.txt`, is still what it is. A `.json` that is
 * neither GeoJSON nor an array of objects is not an import at all — the
 * caller keeps sending prose to the model as before.
 *
 * Nothing here decides validity; a row with a bad coordinate still comes
 * out, so the summary can say why it was skipped.
 *
 * Client-safe. KML parsing needs DOMParser and says so when it is absent.
 */
import { jsonToRawRows } from '@/lib/services/workflows/data/tableUtils';

import { NamedConnection } from '@/lib/utils/shared/geo/connections';
import {
  LonLat,
  boundingCentre,
  flattenPositions,
} from '@/lib/utils/shared/geo/geometry';

import Papa from 'papaparse';

export type ImportFormat = 'geojson' | 'kml' | 'csv' | 'tsv' | 'json';

/** How a row's position was obtained when it did not come from columns. */
export type GeometryOrigin =
  | 'point'
  /** A shape reduced to its centre + covering radius. */
  | 'area'
  | 'line';

export interface RawImportRow {
  /** 1-based position in the source, for messages ("row 12"). */
  index: number;
  values: Record<string, unknown>;
  /** Position from geometry (GeoJSON/KML); outranks any lat/lon column. */
  lonLat?: LonLat;
  geometry?: GeometryOrigin;
  /** Covering radius when `geometry` is 'area' or 'line'. */
  radiusKm?: number;
}

export interface ParsedImport {
  format: ImportFormat;
  headers: string[];
  rows: RawImportRow[];
  /** Name-referenced connections found in the file (our own export's LineStrings). */
  connections: NamedConnection[];
  /** Things worth telling the user that are not per-row problems. */
  notes: ImportNote[];
}

export type ImportNote =
  | { kind: 'geometry_collection_flattened'; count: number }
  | { kind: 'unsupported_geometry'; type: string; count: number }
  | { kind: 'kml_folders_flattened' };

export class ImportParseError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'empty'
      | 'invalid_json'
      | 'invalid_geojson'
      | 'invalid_kml'
      | 'no_dom_parser'
      | 'delimiter'
      | 'not_tabular',
  ) {
    super(message);
    this.name = 'ImportParseError';
  }
}

/* ------------------------------------------------------------------ */
/* Sniffing                                                            */
/* ------------------------------------------------------------------ */

const GEOJSON_TYPES = new Set([
  'FeatureCollection',
  'Feature',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

/**
 * What kind of import a text is, or null when it is prose (or JSON that is
 * not location data) and should go to the model instead.
 */
export function sniffImportFormat(
  fileName: string | undefined,
  text: string,
): ImportFormat | null {
  const head = text.slice(0, 4096).trimStart();
  const lower = (fileName ?? '').toLowerCase();

  if (head.startsWith('<')) {
    return /<kml[\s>]/i.test(head) || lower.endsWith('.kml') ? 'kml' : null;
  }
  if (head.startsWith('{') || head.startsWith('[')) {
    const type = /"type"\s*:\s*"([A-Za-z]+)"/.exec(head)?.[1];
    if (type && GEOJSON_TYPES.has(type)) return 'geojson';
    if (lower.endsWith('.geojson')) return 'geojson';
    // An array of objects is tabular JSON; anything else is not an import.
    if (head.startsWith('[') && /^\[\s*\{/.test(head)) return 'json';
    if (lower.endsWith('.json') && /"[^"]+"\s*:\s*\[\s*\{/.test(head)) {
      return 'json';
    }
    return null;
  }
  if (lower.endsWith('.tsv') || lower.endsWith('.tab')) return 'tsv';
  if (lower.endsWith('.csv')) return 'csv';
  // Extension-less paste: a header row that names coordinates is tabular.
  const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
  if (/(^|[,;\t])\s*(lat|latitude|y)\s*([,;\t]|$)/i.test(firstLine)) {
    return firstLine.includes('\t') ? 'tsv' : 'csv';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* GeoJSON                                                             */
/* ------------------------------------------------------------------ */

interface GeoJsonGeometryLike {
  type?: string;
  coordinates?: unknown;
  geometries?: GeoJsonGeometryLike[];
}

interface GeoJsonFeatureLike {
  type?: string;
  geometry?: GeoJsonGeometryLike | null;
  properties?: Record<string, unknown> | null;
  id?: unknown;
}

function scalarProperties(
  properties: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!properties) return out;
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue; // nested — not a column
    out[key] = value;
  }
  return out;
}

/**
 * Expands one geometry into positioned rows. A Point is one row; a
 * MultiPoint one per point (names suffixed downstream); lines and areas one
 * row at their centre with a covering radius, tagged so the summary can say
 * they were approximated; a GeometryCollection is each member in turn.
 */
function geometryRows(
  geometry: GeoJsonGeometryLike | null | undefined,
  notes: ImportNote[],
  unsupported: Map<string, number>,
): Array<Pick<RawImportRow, 'lonLat' | 'geometry' | 'radiusKm'>> {
  if (!geometry || typeof geometry !== 'object') return [];
  switch (geometry.type) {
    case 'Point': {
      const [p] = flattenPositions(geometry.coordinates);
      return p ? [{ lonLat: p, geometry: 'point' }] : [];
    }
    case 'MultiPoint':
      return flattenPositions(geometry.coordinates).map((p) => ({
        lonLat: p,
        geometry: 'point' as const,
      }));
    case 'LineString':
    case 'MultiLineString': {
      const centre = boundingCentre(flattenPositions(geometry.coordinates));
      return centre
        ? [
            {
              lonLat: [centre.lon, centre.lat],
              geometry: 'line',
              radiusKm: centre.radiusKm,
            },
          ]
        : [];
    }
    case 'Polygon':
    case 'MultiPolygon': {
      const centre = boundingCentre(flattenPositions(geometry.coordinates));
      return centre
        ? [
            {
              lonLat: [centre.lon, centre.lat],
              geometry: 'area',
              radiusKm: centre.radiusKm,
            },
          ]
        : [];
    }
    case 'GeometryCollection': {
      const members = Array.isArray(geometry.geometries)
        ? geometry.geometries
        : [];
      if (members.length > 0) {
        notes.push({
          kind: 'geometry_collection_flattened',
          count: members.length,
        });
      }
      return members.flatMap((g) => geometryRows(g, notes, unsupported));
    }
    default: {
      const type = String(geometry.type ?? 'unknown');
      unsupported.set(type, (unsupported.get(type) ?? 0) + 1);
      return [];
    }
  }
}

/** Our own export writes connections as LineStrings carrying both endpoint names. */
function isExportedConnection(feature: GeoJsonFeatureLike): boolean {
  const props = feature.properties ?? {};
  return (
    feature.geometry?.type === 'LineString' &&
    typeof props.fromName === 'string' &&
    typeof props.toName === 'string'
  );
}

export function parseGeoJson(text: string): ParsedImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportParseError('Not valid JSON', 'invalid_json');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ImportParseError('Not a GeoJSON object', 'invalid_geojson');
  }
  const root = parsed as GeoJsonFeatureLike & { features?: unknown };

  let features: GeoJsonFeatureLike[];
  if (root.type === 'FeatureCollection') {
    features = Array.isArray(root.features)
      ? (root.features as GeoJsonFeatureLike[])
      : [];
  } else if (root.type === 'Feature') {
    features = [root];
  } else if (root.type && GEOJSON_TYPES.has(root.type)) {
    // A bare geometry: one nameless feature.
    features = [
      {
        type: 'Feature',
        geometry: root as GeoJsonGeometryLike,
        properties: {},
      },
    ];
  } else {
    throw new ImportParseError('Not a GeoJSON object', 'invalid_geojson');
  }

  const notes: ImportNote[] = [];
  const unsupported = new Map<string, number>();
  const rows: RawImportRow[] = [];
  const connections: NamedConnection[] = [];
  const headerSet = new Set<string>();
  let index = 0;

  for (const feature of features) {
    if (!feature || typeof feature !== 'object') continue;
    index += 1;
    if (isExportedConnection(feature)) {
      const props = feature.properties as Record<string, unknown>;
      connections.push({
        fromName: String(props.fromName),
        toName: String(props.toName),
        kind: typeof props.kind === 'string' ? props.kind : '',
        description:
          typeof props.description === 'string' ? props.description : '',
      });
      continue;
    }
    const values = scalarProperties(feature.properties);
    if (
      values.name === undefined &&
      feature.id !== undefined &&
      feature.id !== null &&
      typeof feature.id !== 'object'
    ) {
      // Many producers put the identifier on `id` and nothing in properties.
      values.id = feature.id;
    }
    for (const key of Object.keys(values)) headerSet.add(key);

    const positioned = geometryRows(feature.geometry, notes, unsupported);
    if (positioned.length === 0) {
      // No usable geometry: still a row, so the summary can count the skip.
      rows.push({ index, values });
      continue;
    }
    positioned.forEach((pos, i) => {
      rows.push({
        index,
        values:
          positioned.length > 1 && typeof values.name === 'string'
            ? { ...values, name: `${values.name} (${i + 1})` }
            : values,
        ...pos,
      });
    });
  }
  for (const [type, count] of unsupported) {
    notes.push({ kind: 'unsupported_geometry', type, count });
  }
  return {
    format: 'geojson',
    headers: [...headerSet],
    rows,
    connections,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* KML                                                                 */
/* ------------------------------------------------------------------ */

/** "lon,lat[,alt] lon,lat[,alt] …" → positions. */
function parseKmlCoordinates(text: string): LonLat[] {
  return text
    .trim()
    .split(/\s+/)
    .map((tuple) => tuple.split(',').map(Number))
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
    .map(([lon, lat]) => [lon, lat] as LonLat);
}

function childText(el: Element, tag: string): string | undefined {
  for (const child of Array.from(el.children)) {
    if (child.localName === tag) return child.textContent?.trim() || undefined;
  }
  return undefined;
}

function firstDescendant(el: Element, tag: string): Element | null {
  return el.getElementsByTagName(tag)[0] ?? null;
}

export function parseKml(text: string): ParsedImport {
  if (typeof DOMParser === 'undefined') {
    throw new ImportParseError('KML needs a browser to parse', 'no_dom_parser');
  }
  // DOMParser never fetches external entities or runs scripts, so hostile
  // KML degrades to a parse error or inert elements.
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new ImportParseError('Not valid KML', 'invalid_kml');
  }
  const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
  const rows: RawImportRow[] = [];
  const connections: NamedConnection[] = [];
  const headerSet = new Set<string>(['name', 'description']);
  const notes: ImportNote[] = [];
  if (doc.getElementsByTagName('Folder').length > 0) {
    notes.push({ kind: 'kml_folders_flattened' });
  }

  placemarks.forEach((pm, i) => {
    const values: Record<string, unknown> = {};
    const name = childText(pm, 'name');
    const description = childText(pm, 'description');
    if (name) values.name = name;
    if (description) values.description = description;

    // ExtendedData/Data[name]/value and SchemaData/SimpleData[name].
    for (const data of Array.from(pm.getElementsByTagName('Data'))) {
      const key = data.getAttribute('name');
      const value = childText(data, 'value');
      if (key && value !== undefined) {
        values[key] = value;
        headerSet.add(key);
      }
    }
    for (const simple of Array.from(pm.getElementsByTagName('SimpleData'))) {
      const key = simple.getAttribute('name');
      const value = simple.textContent?.trim();
      if (key && value) {
        values[key] = value;
        headerSet.add(key);
      }
    }
    // Timing: TimeStamp/when or TimeSpan/begin,end.
    const stamp = firstDescendant(pm, 'TimeStamp');
    const span = firstDescendant(pm, 'TimeSpan');
    if (stamp) {
      const when = childText(stamp, 'when');
      if (when) {
        values.event_start = when;
        headerSet.add('event_start');
      }
    } else if (span) {
      const begin = childText(span, 'begin');
      const end = childText(span, 'end');
      if (begin) {
        values.event_start = begin;
        headerSet.add('event_start');
      }
      if (end) {
        values.event_end = end;
        headerSet.add('event_end');
      }
    }

    const index = i + 1;
    const point = firstDescendant(pm, 'Point');
    const line = firstDescendant(pm, 'LineString');
    const polygon = firstDescendant(pm, 'Polygon');
    if (point) {
      const [p] = parseKmlCoordinates(childText(point, 'coordinates') ?? '');
      rows.push(
        p ? { index, values, lonLat: p, geometry: 'point' } : { index, values },
      );
      return;
    }
    const shape = line ?? polygon;
    if (shape) {
      const coordsText = Array.from(shape.getElementsByTagName('coordinates'))
        .map((c) => c.textContent ?? '')
        .join(' ');
      const centre = boundingCentre(parseKmlCoordinates(coordsText));
      if (centre) {
        rows.push({
          index,
          values,
          lonLat: [centre.lon, centre.lat],
          geometry: line ? 'line' : 'area',
          radiusKm: centre.radiusKm,
        });
        return;
      }
    }
    rows.push({ index, values });
  });

  return { format: 'kml', headers: [...headerSet], rows, connections, notes };
}

/* ------------------------------------------------------------------ */
/* Tabular                                                             */
/* ------------------------------------------------------------------ */

function rowsFromObjects(
  objects: Record<string, unknown>[],
  format: ImportFormat,
): ParsedImport {
  const headerSet = new Set<string>();
  const rows: RawImportRow[] = objects.map((values, i) => {
    for (const key of Object.keys(values)) headerSet.add(key);
    return { index: i + 1, values };
  });
  return { format, headers: [...headerSet], rows, connections: [], notes: [] };
}

/**
 * CSV / TSV. Cells are kept as strings — coercion is the validator's job,
 * and it wants to see exactly what was typed ("01", "1,5", "N/A").
 */
export function parseDelimited(
  text: string,
  format: 'csv' | 'tsv',
): ParsedImport {
  const trimmed = text.trim();
  if (!trimmed) throw new ImportParseError('The file is empty', 'empty');
  const result = Papa.parse<Record<string, unknown>>(trimmed, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: 'greedy',
    delimiter: format === 'tsv' ? '\t' : undefined,
  });
  const fatal = result.errors.find((e) => e.type === 'Delimiter');
  if (fatal) throw new ImportParseError(fatal.message, 'delimiter');
  const parsed = rowsFromObjects(result.data, format);
  parsed.headers = result.meta.fields ?? parsed.headers;
  return parsed;
}

/** A JSON array of flat objects (or a single-key wrapper around one). */
export function parseJsonRows(text: string): ParsedImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportParseError('Not valid JSON', 'invalid_json');
  }
  let objects: Record<string, unknown>[];
  try {
    objects = jsonToRawRows(parsed);
  } catch {
    throw new ImportParseError(
      'JSON must be an array of objects',
      'not_tabular',
    );
  }
  return rowsFromObjects(
    objects.map((row) => scalarProperties(row)),
    'json',
  );
}

/** Dispatches on a sniffed format. */
export function parseImport(format: ImportFormat, text: string): ParsedImport {
  switch (format) {
    case 'geojson':
      return parseGeoJson(text);
    case 'kml':
      return parseKml(text);
    case 'json':
      return parseJsonRows(text);
    case 'csv':
    case 'tsv':
      return parseDelimited(text, format);
  }
}
