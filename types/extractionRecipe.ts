/**
 * Structured data extraction types.
 *
 * Recipes are saved structures (see `types/structure.ts`) used in extraction
 * mode: user-authored, persisted locally in `useSettingsStore.savedStructures`,
 * and travelling inline with each chat request (mirroring how `tones` and
 * `prompts` cross the wire today — the server has no structure store).
 *
 * A turn that carries an `ExtractionRequest` is rendered server-side via the
 * OpenAI structured-outputs API (`response_format: { type: 'json_schema' }`),
 * and the result is parsed into an `ExtractionResultContent` message that the
 * chat surface renders as up to three stacked tables.
 */
import {
  SavedStructure,
  StructureField,
  StructureFieldType,
} from './structure';

/**
 * @deprecated Extraction-era aliases kept so existing call sites read the
 * same. New code should use the `Structure*` names from `types/structure.ts`.
 *
 * Note the polarity change these aliases inherit: `required` now means
 * absent = **optional** (it previously meant absent = required). The settings
 * v41 migration stamps the flag explicitly on every legacy field.
 */
export type FieldType = StructureFieldType;
export type RecipeField = StructureField;
export type ExtractionRecipe = SavedStructure;

/**
 * Extraction payload attached to a chat request body. Carried inline because
 * the server has no structure store — the client persists them in
 * localStorage via `useSettingsStore.savedStructures` and sends the
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
