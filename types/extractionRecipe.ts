/**
 * Structured data extraction types.
 *
 * Recipes are user-authored, persisted locally in `useSettingsStore.extractionRecipes`,
 * and travel inline with each chat request (mirroring how `tones` and `prompts`
 * cross the wire today — the server has no recipe store).
 *
 * A turn that carries an `ExtractionRequest` is rendered server-side via the
 * OpenAI structured-outputs API (`response_format: { type: 'json_schema' }`),
 * and the result is parsed into an `ExtractionResultContent` message that the
 * chat surface renders as up to three stacked tables.
 */

/**
 * Field types supported by the recipe builder. Each maps to a JSON Schema
 * fragment via `recipeToJsonSchema`. Lists are flat (no nested objects in v1)
 * to keep the field-builder UX simple.
 */
export type FieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'boolean'
  | 'enum'
  | 'list<text>'
  | 'list<number>';

/**
 * A single field on a recipe.
 *
 * `name` is used verbatim as the JSON key in the structured output (so it
 * should be a stable identifier — the UI snake_case's it on entry). `label`
 * is the optional display name shown in the result-table header; when absent,
 * the renderer falls back to `name`.
 */
export interface RecipeField {
  id: string;
  name: string;
  label?: string;
  type: FieldType;
  description?: string;
  /** Defaults to true in the UI; explicitly false marks the field optional. */
  required?: boolean;
  /** Required when `type === 'enum'`; ignored otherwise. */
  enumValues?: string[];
}

/**
 * A saved extraction recipe. `instructions` is free-text "what to look for"
 * that the model receives alongside the schema — it does the work the schema
 * cannot (disambiguating intent, scoping the source material).
 */
export interface ExtractionRecipe {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  fields: RecipeField[];
  createdAt: string;
  updatedAt: string;
  /** Optional hint, reserved for future ranking in the recipe picker. */
  sourceHint?: 'pdf' | 'transcript' | 'spreadsheet' | 'web' | 'any';

  // Team-template metadata, mirroring Prompt/CustomAgent shapes.
  templateId?: string;
  templateName?: string;
  importedAt?: string;
}

/**
 * Extraction payload attached to a chat request body. Carried inline because
 * the server has no recipe store — the client persists recipes in
 * localStorage via `useSettingsStore.extractionRecipes` and sends the
 * selected subset on each turn (just like tones/prompts).
 *
 * Up to three recipes per request — enforced by the UI (the "+ add recipe"
 * button disables at three) and validated again server-side in
 * `InputValidator`.
 */
export interface ExtractionRequest {
  recipeIds: string[];
  recipes: ExtractionRecipe[];
  /**
   * When true AND `recipes` is empty, the server runs auto mode: the model
   * proposes its own structure for the material. The result is returned
   * with the proposed schema so the UI can offer "Save as recipe".
   */
  autoMode?: boolean;
}

/**
 * Composite response_format for the OpenAI structured-outputs call, written
 * to `ChatContext.responseFormat` by `ExtractionEnricher` and consumed by
 * `StandardChatHandler`.
 *
 * `recipeOrder` preserves the request-time recipe ordering so the renderer
 * can match output keys back to their recipe ids (the keys themselves are
 * slugged from `recipe.name`, which is not a stable identifier).
 */
export interface ExtractionResponseFormat {
  name: string;
  schema: Record<string, unknown>;
  strict: boolean;
  recipeOrder: string[];
  /** Map of `recipe.id` → JSON key in the composite schema. */
  keyByRecipeId?: Record<string, string>;
}
