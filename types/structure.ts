/**
 * Shared user-defined data structures.
 *
 * A "structure" is a named, saved list of fields describing the shape of some
 * data. Two surfaces consume them:
 *
 *  - **Extraction** — a structure plus free-text `instructions` is a recipe;
 *    it becomes a strict json_schema via `recipeToJsonSchema`.
 *  - **Data workflow** — a structure seeds a table's columns via
 *    `structureToColumns`; a table can be saved back as one.
 *
 * Both were built independently (see the note atop
 * `lib/services/workflows/data/tableSchema.ts`) and are unified here so a
 * structure authored on either surface is reusable on the other.
 */

/**
 * Field types a table can hold. Tabular surfaces (the data workflow's grid,
 * CSV/XLSX ingestion) store one scalar per cell, so they accept only these.
 */
export const TABULAR_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'boolean',
] as const;

export type TabularFieldType = (typeof TABULAR_FIELD_TYPES)[number];

/**
 * The full field-type vocabulary. Extraction supports the tabular scalars
 * plus `enum` and flat lists; those three have no cell representation, so
 * `structureToColumns` downgrades them to `text` and reports which fields it
 * touched. Lists stay flat (no nested objects) to keep the builder simple.
 */
export type StructureFieldType =
  | TabularFieldType
  | 'enum'
  | 'list<text>'
  | 'list<number>';

export function isTabularFieldType(
  type: StructureFieldType,
): type is TabularFieldType {
  return (TABULAR_FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * A single field on a structure.
 *
 * `name` is used verbatim as the JSON key in structured output (so it should
 * be a stable identifier — the builder snake_case's it on entry). `label` is
 * the optional display name for result-table headers; renderers fall back to
 * `name`.
 */
export interface StructureField {
  id: string;
  name: string;
  label?: string;
  type: StructureFieldType;
  description?: string;
  /**
   * Canonical polarity: absent or false means **optional**.
   *
   * Extraction recipes used the opposite convention before settings v41
   * (absent meant required); the v41 migration stamps `required: true` onto
   * every legacy field that omitted it, so nothing here is ambiguous.
   */
  required?: boolean;
  /** Required when `type === 'enum'`; ignored otherwise. */
  enumValues?: string[];
}

/**
 * A saved, reusable structure. Persisted in
 * `useSettingsStore.savedStructures` and — for extraction — sent inline with
 * each chat request (the server has no structure store).
 */
export interface SavedStructure {
  id: string;
  name: string;
  description?: string;
  /**
   * Free-text "what to look for" that extraction sends alongside the schema,
   * doing the work the schema cannot (disambiguating intent, scoping the
   * source material). Tabular surfaces ignore it.
   */
  instructions?: string;
  fields: StructureField[];
  createdAt: string;
  updatedAt: string;
  /** Optional hint, reserved for future ranking in the structure picker. */
  sourceHint?: 'pdf' | 'transcript' | 'spreadsheet' | 'web' | 'any';

  // Team-template metadata, mirroring Prompt/CustomAgent shapes.
  templateId?: string;
  templateName?: string;
  importedAt?: string;
}
