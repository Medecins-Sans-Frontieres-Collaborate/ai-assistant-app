/**
 * Shapes models discovered from a local runtime into the app's OpenAIModel.
 *
 * Kept separate from customModelSources.ts (the Foundry "BYO model" builder)
 * because that module imports `node:crypto` — this one must run in the
 * browser, since local runtimes are reached browser-direct.
 */
import {
  LOCAL_RUNTIMES,
  LOCAL_RUNTIME_DEFAULTS,
  LocalRuntime,
} from '@/types/localRuntime';
import { OpenAIModel } from '@/types/openai';

export const LOCAL_MODEL_ID_PREFIX = 'local-';

/**
 * Conservative context/output defaults, mirroring synthesizeUnknownModel in
 * modelResolution.ts. A local runtime's /v1/models does not report context
 * length, and guessing high would silently truncate.
 */
const LOCAL_MAX_LENGTH = 32000;
const LOCAL_TOKEN_LIMIT = 4096;

/**
 * `local-<runtime>-<modelName>`, e.g. `local-ollama-llama3.1:8b`.
 *
 * The PORT is deliberately not part of the id. It is user-editable, so
 * hashing it in would orphan every persisted conversation the moment someone
 * changes it. The runtime is the stable identity and makes cross-runtime
 * collisions impossible.
 *
 * Model names legitimately contain ':' and '/' (`hf.co/user/repo:Q4_K_M`);
 * they are kept raw rather than escaped, so ids stay recognizable.
 */
export function buildLocalModelId(
  runtime: LocalRuntime,
  modelName: string,
): string {
  return `${LOCAL_MODEL_ID_PREFIX}${runtime}-${modelName}`;
}

export function isLocalModelId(id: string | undefined | null): boolean {
  return typeof id === 'string' && id.startsWith(LOCAL_MODEL_ID_PREFIX);
}

/**
 * The single predicate every guard should use, rather than open-coding a
 * `startsWith` check. Accepts a partial so callers can pass a whole model or
 * just an id-bearing object.
 */
export function isLocalModel(
  model: Pick<OpenAIModel, 'id' | 'isLocalModel'> | undefined | null,
): boolean {
  if (!model) return false;
  return model.isLocalModel === true || isLocalModelId(model.id);
}

/**
 * Splits a local model id back into its parts, or null if it isn't one.
 * Splits on the FIRST '-' after the runtime so model names keep their dashes.
 */
export function parseLocalModelId(
  id: string,
): { runtime: LocalRuntime; modelName: string } | null {
  if (!isLocalModelId(id)) return null;
  const rest = id.slice(LOCAL_MODEL_ID_PREFIX.length);
  for (const runtime of LOCAL_RUNTIMES) {
    const prefix = `${runtime}-`;
    if (rest.startsWith(prefix)) {
      const modelName = rest.slice(prefix.length);
      return modelName ? { runtime, modelName } : null;
    }
  }
  return null;
}

/**
 * Builds the picker/chat model for one locally-served model.
 *
 * Conservative on capability: tools, vision, reasoning effort and verbosity
 * are all off. The browser-direct path has no server pipeline behind it — no
 * image inflation, no MCP tool loop — so advertising those would produce
 * silent no-ops rather than useful behavior.
 */
export function buildLocalModel(
  runtime: LocalRuntime,
  modelName: string,
): OpenAIModel {
  return {
    id: buildLocalModelId(runtime, modelName),
    name: modelName,
    // The wire-level model identifier the runtime expects back.
    deploymentName: modelName,
    maxLength: LOCAL_MAX_LENGTH,
    tokenLimit: LOCAL_TOKEN_LIMIT,
    modelType: 'foundational',
    sdk: 'openai',
    // Inference happens on the user's own machine — neither inside MSF's
    // Azure environment nor at a third-party provider. Set explicitly so
    // getModelHosting() can't default these to 'azure' and make a false
    // compliance claim.
    hosting: 'local',
    isLocalModel: true,
    localRuntime: runtime,
    localRuntimeLabel: LOCAL_RUNTIME_DEFAULTS[runtime].label,
    supportsTemperature: true,
    supportsTools: false,
    supportsVision: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
    isDisabled: false,
    // `provider` and `series` are deliberately omitted: there is no 'local'
    // provider in the union, and local models render as their own standalone
    // picker section rather than merging into catalog families.
  };
}
