/**
 * Server-side registry of organization RAG agents: the static
 * config/organization-agents.json entries merged with the admin-authored
 * blob records (docs/AGENT_ACCESS_CONTROL.md machinery).
 *
 * Merge rule — admin records win by id:
 *  - a SERVEABLE admin record (enabled + validation ok) replaces the static
 *    entry with the same id, or appends when the id is new (`orgr-<hex>`);
 *  - `enabled: false` retires the agent outright (an override of a static
 *    entry suppresses it — that is the no-deploy kill switch);
 *  - a record whose validation FAILED falls back to the static entry when
 *    one exists (the file config was working before the override) and to
 *    nothing otherwise — a broken index must never serve.
 *
 * Client bundles still import the static file directly for instant paint;
 * admin records reach clients through /api/agents. This module is the ONLY
 * lookup chat-time code should use — the static `getOrganizationAgentById`
 * cannot see admin records.
 */
import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { OrgRagAgent } from '@/lib/services/agentAccess/types';
import {
  checkIndexServeableCached,
  peekIndexServeable,
} from '@/lib/services/orgAgents/orgAgentSearchValidation';

import { OrganizationAgent } from '@/types/organizationAgent';

import {
  getOrganizationAgentById,
  getOrganizationAgents,
} from '@/lib/organizationAgents';

/** Projects an admin record onto the shape the RAG pipeline consumes. */
export function toOrganizationAgent(record: OrgRagAgent): OrganizationAgent {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    icon: record.icon,
    color: record.color,
    ...(record.maintainedBy && { maintainedBy: record.maintainedBy }),
    type: 'rag',
    enabled: record.enabled,
    ...(record.category && { category: record.category }),
    ...(record.systemPrompt && { systemPrompt: record.systemPrompt }),
    sources: record.sources.map((s) => ({ name: s.name, url: s.url })),
    ragConfig: {
      searchIndex: record.searchIndex,
      ...(record.semanticConfig && { semanticConfig: record.semanticConfig }),
      topK: record.topK,
    },
    allowWebSearch: record.allowWebSearch,
    allowCodeInterpreter: record.allowCodeInterpreter,
    ...(record.baseModelId && { baseModelId: record.baseModelId }),
  };
}

function isServeable(record: OrgRagAgent): boolean {
  return record.enabled && record.validation.status === 'ok';
}

/**
 * Full serveability: the persisted save-time validation PLUS the cached
 * serve-time recheck (an index deleted after the save flips the agent out
 * within ~5 minutes; probe errors fail open — see the validation module).
 */
async function isServeableNow(record: OrgRagAgent): Promise<boolean> {
  if (!isServeable(record)) return false;
  return checkIndexServeableCached(record.searchIndex, record.semanticConfig);
}

/**
 * Resolves one org agent by id (conversation.bot / botId), admin records
 * first. Async because the access-control snapshot may need a refresh; when
 * the agent-access feature is disabled this degrades to the static lookup.
 */
export async function resolveOrgAgentById(
  id: string,
): Promise<OrganizationAgent | null> {
  const service = AgentAccessService.getInstance();
  if (service.isEnabled()) {
    await service.ensureFresh();
    const record = service.getOrgAgentById(id);
    if (record) {
      if (!record.enabled) {
        // Explicit admin intent: the agent (including an overridden static
        // entry) is retired — never fall back to the file.
        return null;
      }
      if (await isServeableNow(record)) return toOrganizationAgent(record);
      // Validation failed (at save time, or the serve-time recheck caught a
      // vanished index): serve the static entry when this record overrides
      // one (the file config predates the broken override); otherwise
      // nothing. RAGEnricher treats null as "no agent" and degrades.
      console.warn(
        `[org-agents] record '${id}' is not serveable (failed validation or index recheck); ${
          getOrganizationAgentById(id)
            ? 'serving the static config entry instead'
            : 'no fallback exists'
        }`,
      );
    }
  }
  return getOrganizationAgentById(id) ?? null;
}

/**
 * Synchronous best-effort resolve over the CURRENT access snapshot (no
 * refresh) — for sync call sites like PipelineStage.shouldRun. Identical
 * merge semantics to {@link resolveOrgAgentById}; on a cold snapshot an
 * admin record is simply not visible yet, so its tool gates deny (fail
 * closed) and the static config still serves.
 */
export function peekOrgAgentById(id: string): OrganizationAgent | null {
  const service = AgentAccessService.getInstance();
  if (service.isEnabled()) {
    const record = service.getOrgAgentById(id);
    if (record) {
      if (
        isServeable(record) &&
        peekIndexServeable(record.searchIndex, record.semanticConfig)
      ) {
        return toOrganizationAgent(record);
      }
      if (!record.enabled) return null;
    }
  }
  return getOrganizationAgentById(id) ?? null;
}

/**
 * Admin records that are currently serveable — the discovery surface
 * (/api/agents) reads this; layer-1 access filtering happens there.
 */
export async function getServeableAdminOrgAgents(): Promise<OrgRagAgent[]> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return [];
  await service.ensureFresh();
  const candidates = service.getOrgAgents().filter(isServeable);
  const flags = await Promise.all(candidates.map(isServeableNow));
  return candidates.filter((_, index) => flags[index]);
}

/**
 * Ids of static config agents that admin records currently suppress from
 * display — overrides (serveable records replacing a static entry) and
 * explicit disables. Served to clients so the bundled static list can be
 * trimmed without a deploy.
 */
export async function getSuppressedStaticAgentIds(): Promise<string[]> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return [];
  await service.ensureFresh();
  const staticIds = new Set(getOrganizationAgents().map((agent) => agent.id));
  const overrides = service
    .getOrgAgents()
    .filter((record) => staticIds.has(record.id));
  const suppressed = await Promise.all(
    overrides.map(
      async (record) => !record.enabled || (await isServeableNow(record)),
    ),
  );
  return overrides
    .filter((_, index) => suppressed[index])
    .map((record) => record.id);
}
