/**
 * Model Discovery Service
 *
 * Lists the models actually DEPLOYED in an Azure AI Foundry account via the
 * Azure Resource Manager (ARM) control plane. This is the source of truth for
 * model *availability* (per region); local metadata in config/models.json
 * supplies presentation + routing. See docs/MODEL_DISCOVERY_DESIGN.md.
 *
 * Design notes (validated by scripts/discover-foundry-models.mjs against EU):
 *  - ARM is the only working path on `kind=AIServices` resources; the Foundry
 *    data-plane deployment listing 404s.
 *  - Deployments are ACCOUNT-scoped: callers pass any Foundry resource path and
 *    we strip `/projects/<name>` to the account path before querying.
 *  - Runs under the APP identity (account Reader), NOT per-user OBO — deployed
 *    models are identical for every user in a region, so the cache is keyed by
 *    account path, not by user.
 *  - The deployment `name` is the join key against OpenAIModelID, NOT the
 *    underlying `properties.model.name` (which can differ, e.g. a `gpt-5.2`
 *    deployment running model `gpt-5.5`).
 */
import {
  isValidFoundryResourcePath,
  stripToAccountPath,
} from '@/lib/utils/shared/armPath';

const ARM_API_VERSION = '2024-10-01';

// 1h: deployments change rarely (an admin adds/removes a model occasionally).
// The route exposes a `refresh` escape hatch for on-demand invalidation.
const CACHE_TTL_MS = 60 * 60 * 1000;

// Safety cap so a misconfigured account with a runaway deployment count can't
// stall discovery. Far above any realistic per-account deployment count.
const PAGE_LIMIT = 50;

/** A model deployment discovered from Azure, normalized for the merge layer. */
export interface DeployedModel {
  /** ARM deployment name — the join key against OpenAIModelID / model metadata. */
  deploymentName: string;
  /** Underlying model name (properties.model.name); may differ from deploymentName. */
  modelName: string;
  /** Underlying model version. */
  modelVersion?: string;
  /** Model publisher/format (properties.model.format), e.g. "OpenAI", "Meta". */
  publisher?: string;
  /** SKU name, e.g. "GlobalStandard", "DataZoneStandard". */
  sku?: string;
  /** Provisioned capacity. */
  capacity?: number;
  /** Capability flags as returned by ARM (string-valued, e.g. chatCompletion: "true"). */
  capabilities: Record<string, string>;
  /** Provisioning state, e.g. "Succeeded". */
  provisioningState?: string;
  /** ARM resource tags — used by the metadata overlay (ui-* keys). */
  tags: Record<string, string>;
}

/** Raw shape of a deployment as returned by the ARM list endpoint. */
interface ArmDeployment {
  name?: string;
  sku?: { name?: string; capacity?: number };
  tags?: Record<string, string>;
  properties?: {
    model?: { format?: string; name?: string; version?: string };
    provisioningState?: string;
    capabilities?: Record<string, string>;
  };
}

interface ArmDeploymentListPage {
  value?: ArmDeployment[];
  nextLink?: string;
}

interface CachedDeployments {
  models: DeployedModel[];
  expiresAt: number;
}

export class ModelDiscoveryService {
  private static instance: ModelDiscoveryService | null = null;
  // Keyed by account resource path (region), NOT by user — see file header.
  private cache = new Map<string, CachedDeployments>();

  static getInstance(): ModelDiscoveryService {
    if (!ModelDiscoveryService.instance) {
      ModelDiscoveryService.instance = new ModelDiscoveryService();
    }
    return ModelDiscoveryService.instance;
  }

  /** Clears the discovery cache (used by the route's `refresh` param). */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Lists chat-capable model deployments in a Foundry account.
   *
   * @param armToken - App-identity ARM token (scope https://management.azure.com/.default)
   * @param resourcePath - Any Foundry resource path; stripped to the account scope
   */
  async listDeployedModels(
    armToken: string,
    resourcePath: string,
  ): Promise<DeployedModel[]> {
    const accountPath = stripToAccountPath(resourcePath);

    // Defense-in-depth: validate the (account) path before building the ARM URL
    // so the dataflow guard is locally explicit (mirrors AgentDiscoveryService).
    if (!isValidFoundryResourcePath(accountPath)) {
      throw new Error('Invalid Foundry resource path');
    }

    const cached = this.cache.get(accountPath);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.models;
    }

    const raw = await this.fetchAllDeployments(armToken, accountPath);
    const models = raw
      .map((d) => this.toDeployedModel(d))
      .filter((m): m is DeployedModel => m !== null)
      .filter((m) => this.isChatCapable(m));

    this.cache.set(accountPath, {
      models,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    console.log(
      `[ModelDiscoveryService] Discovered ${models.length} chat-capable deployment(s) in account`,
    );
    return models;
  }

  /** Walks the ARM `nextLink` pagination, capped at PAGE_LIMIT pages. */
  private async fetchAllDeployments(
    armToken: string,
    accountPath: string,
  ): Promise<ArmDeployment[]> {
    const all: ArmDeployment[] = [];
    let url: string | undefined =
      `https://management.azure.com${accountPath}/deployments?api-version=${ARM_API_VERSION}`;

    for (let page = 0; url && page < PAGE_LIMIT; page++) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${armToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(
          `[ModelDiscoveryService] ARM API error (${response.status}):`,
          body,
        );
        throw new Error(
          `Failed to list model deployments: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as ArmDeploymentListPage;
      if (data.value) all.push(...data.value);
      // nextLink is an absolute ARM URL already carrying the api-version.
      url = data.nextLink;
    }

    return all;
  }

  /** Normalizes a raw ARM deployment; returns null if it has no usable name. */
  private toDeployedModel(d: ArmDeployment): DeployedModel | null {
    const deploymentName = d.name;
    if (!deploymentName) return null;
    const model = d.properties?.model;
    return {
      deploymentName,
      modelName: model?.name ?? deploymentName,
      modelVersion: model?.version,
      publisher: model?.format,
      sku: d.sku?.name,
      capacity: d.sku?.capacity,
      capabilities: d.properties?.capabilities ?? {},
      provisioningState: d.properties?.provisioningState,
      tags: d.tags ?? {},
    };
  }

  /**
   * Keep only successfully-provisioned, chat-capable deployments. ARM reports
   * capability flags as the string "true"; non-chat deployments (whisper,
   * embeddings) lack chatCompletion and are dropped.
   */
  private isChatCapable(m: DeployedModel): boolean {
    const succeeded =
      !m.provisioningState || m.provisioningState === 'Succeeded';
    return succeeded && m.capabilities.chatCompletion === 'true';
  }
}
