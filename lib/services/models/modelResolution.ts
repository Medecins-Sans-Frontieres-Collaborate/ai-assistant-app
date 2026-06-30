/**
 * Model resolution: join live Foundry discovery with local metadata, and apply
 * the environment/ring visibility gate.
 *
 * Pure functions (no I/O) so they're trivially unit-testable. The /api/models
 * route wires these together with ModelDiscoveryService + the request session.
 * See docs/MODEL_DISCOVERY_DESIGN.md (§3.3, §3.4, §3.5).
 */
import { OpenAIModel } from '@/types/openai';

import { DeployedModel } from './ModelDiscoveryService';

import { isModelDisabled } from '@/config/models';

// Conservative defaults for a discovered model we have no metadata for, so it's
// safe to chat with even though we don't know its real limits. Intentionally
// small; real limits come from metadata or ARM ui-* tags.
const UNKNOWN_MAX_LENGTH = 32000;
const UNKNOWN_TOKEN_LIMIT = 4096;

/**
 * Infers which chat handler SDK a discovered model needs from its publisher
 * (ARM `properties.model.format`). Discovery never returns `sdk`, so without
 * this an unknown model can't be routed (HandlerFactory keys on `model.sdk`).
 */
export function inferSdk(publisher?: string): NonNullable<OpenAIModel['sdk']> {
  switch ((publisher ?? '').toLowerCase()) {
    case 'openai':
      return 'azure-openai';
    case 'anthropic':
      return 'anthropic-foundry';
    default:
      // Meta, DeepSeek, Mistral, xAI, etc. all speak the Foundry
      // OpenAI-compatible API via the standard handler.
      return 'openai';
  }
}

/** Maps an ARM publisher/format to our provider enum, or undefined if unmapped. */
export function inferProvider(publisher?: string): OpenAIModel['provider'] {
  switch ((publisher ?? '').toLowerCase()) {
    case 'openai':
      return 'openai';
    case 'anthropic':
      return 'anthropic';
    case 'meta':
      return 'meta';
    case 'deepseek':
      return 'deepseek';
    case 'xai':
      return 'xai';
    default:
      // e.g. "Mistral AI" — no provider enum value; leave undefined (generic UI).
      return undefined;
  }
}

/** Parses a positive integer from a tag value, or undefined. */
function positiveInt(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Overlays ARM `ui-*` resource tags onto a model config. This is how a new
 * model deployed in Azure can get (or override) display + routing metadata
 * without a code push — the same tag convention AgentDiscoveryService uses.
 */
export function applyTagOverlay(
  model: OpenAIModel,
  tags: Record<string, string>,
): OpenAIModel {
  if (!tags || Object.keys(tags).length === 0) return model;
  const m: OpenAIModel = { ...model };

  if (tags['ui-tagline']) m.tagline = tags['ui-tagline'];
  if (tags['ui-description']) m.description = tags['ui-description'];
  const ctx = positiveInt(tags['ui-context']);
  if (ctx) m.maxLength = ctx;
  const out = positiveInt(tags['ui-output']);
  if (out) m.tokenLimit = out;
  if (tags['ui-sdk']) m.sdk = tags['ui-sdk'] as OpenAIModel['sdk'];
  if (tags['ui-provider'])
    m.provider = tags['ui-provider'] as OpenAIModel['provider'];
  if (tags['ui-agent-id']) {
    m.agentId = tags['ui-agent-id'];
    m.isAgent = true;
  }
  return m;
}

/**
 * Synthesizes an OpenAIModel for a discovered deployment we have no metadata
 * for, with inferred routing and conservative defaults. Only surfaced when
 * SHOW_MODELS_WITHOUT_METADATA is on.
 */
export function synthesizeUnknownModel(d: DeployedModel): OpenAIModel {
  const sdk = inferSdk(d.publisher);
  const base: OpenAIModel = {
    id: d.deploymentName,
    name: d.deploymentName,
    maxLength: UNKNOWN_MAX_LENGTH,
    tokenLimit: UNKNOWN_TOKEN_LIMIT,
    modelType: 'foundational',
    provider: inferProvider(d.publisher),
    sdk,
    deploymentName: d.deploymentName,
    // Azure OpenAI GPT/o-series largely reject a custom temperature; other
    // providers accept it. Conservative per-family default.
    supportsTemperature: sdk !== 'azure-openai',
    supportsReasoningEffort: false,
    supportsVerbosity: false,
    supportsVision: false,
  };
  return applyTagOverlay(base, d.tags);
}

export interface MergeOptions {
  /** Show discovered deployments that have no metadata (with inferred defaults). */
  showUnknown: boolean;
}

/**
 * Joins discovered deployments to local metadata on the deployment NAME.
 *
 * Only discovered models appear (so undeployed-but-hardcoded models — e.g.
 * claude-* missing in EU — drop out). Known models are enriched (+ tag overlay);
 * unknown models are synthesized when `showUnknown`, else skipped.
 */
export function mergeDiscoveryWithMetadata(
  deployed: DeployedModel[],
  metadataById: Record<string, OpenAIModel>,
  opts: MergeOptions,
): OpenAIModel[] {
  const out: OpenAIModel[] = [];
  for (const d of deployed) {
    const meta = metadataById[d.deploymentName];
    if (meta) {
      out.push(applyTagOverlay({ ...meta }, d.tags));
    } else if (opts.showUnknown) {
      out.push(synthesizeUnknownModel(d));
    }
  }
  return out;
}

/**
 * Applies the per-ring visibility gate: drops models flagged `isDisabled` or
 * listed in the current environment's `disabledModels` (config/models.ts).
 * Called server-side so a prod-hidden model never reaches the client.
 */
export function applyRingGate(models: OpenAIModel[]): OpenAIModel[] {
  return models.filter((m) => !m.isDisabled && !isModelDisabled(m.id));
}
