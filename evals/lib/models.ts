/**
 * Reads config/models.json directly so the harness never depends on the
 * environment-gated model list (config/models.ts) or ring policy.
 */
import fs from 'fs';
import path from 'path';

export interface EvalModelMeta {
  id: string;
  sdk: 'azure-openai' | 'openai' | 'anthropic-foundry';
  deploymentName?: string;
  avoidSystemPrompt?: boolean;
  supportsTemperature?: boolean;
  supportsReasoningEffort?: boolean;
  tokenLimit?: number;
  pricing?: {
    inputPer1M: number;
    outputPer1M: number;
    cachedInputPer1M?: number;
  };
}

let cache: Record<string, EvalModelMeta> | null = null;

export function loadModelCatalog(): Record<string, EvalModelMeta> {
  if (cache) return cache;
  const file = path.resolve(process.cwd(), 'config/models.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    models: Record<string, Omit<EvalModelMeta, 'id'>>;
  };
  cache = Object.fromEntries(
    Object.entries(raw.models).map(([id, m]) => [id, { id, ...m }]),
  );
  return cache;
}

export function getModelMeta(modelId: string): EvalModelMeta {
  const meta = loadModelCatalog()[modelId];
  if (!meta) {
    throw new Error(
      `Unknown model "${modelId}" — not present in config/models.json`,
    );
  }
  return meta;
}
