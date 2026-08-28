import { Session } from 'next-auth';

/**
 * Per-process singleton evaluating app-layer agent access rules.
 *
 * See docs/AGENT_ACCESS_CONTROL.md. Caching contract: callers `await
 * ensureFresh()` first (no-op while the 60s TTL is warm), then call the
 * synchronous `evaluateAccess()` any number of times over that snapshot.
 * On refresh failure the last-known-good ruleset keeps serving; only when
 * the feature is enabled AND no snapshot was ever loaded does
 * `evaluateAccess` return the distinct 'unavailable' decision — callers
 * fail closed at invocation and pass through at discovery.
 *
 * All existing caches in this app are per-process with no cross-replica
 * invalidation; this follows the same convention with a deliberately short
 * TTL because it is a security control (max revocation latency ≈ 60s).
 */
import {
  StoredAgentAccessRule,
  StoredGuide,
  StoredM365Agent,
  StoredMcpConnector,
  StoredOrgRagAgent,
  StoredPromptAgent,
  bumpGeneration,
  createAgentAccessBlobStorage,
  listAllCatalogOauthApps,
  listAllConnectors,
  listAllGuides,
  listAllM365Agents,
  listAllOrgAgents,
  listAllPromptAgents,
  listAllRules,
  readConfig,
  readGenerationEtag,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AgentAccessConfig,
  CatalogOauthApp,
  Guide,
  M365Agent,
  McpConnector,
  OrgRagAgent,
  PromptAgent,
} from '@/lib/services/agentAccess/types';
import { canonicalAgentKey } from '@/lib/services/agentAccess/types';
import { getCachedGroupIdsForMail } from '@/lib/services/m365/groupMembership';
import { getAzureMonitorLogger } from '@/lib/services/observability/AzureMonitorLoggingService';
import {
  Principal,
  domainOfMail,
  matchesPrincipal,
  normalizeMail,
} from '@/lib/services/shared/principalMatching';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { RequestTelemetry } from '@/lib/types/logging';

import { env } from '@/config/environment';

const RULES_CACHE_TTL_MS = 60_000;
/**
 * After a failed refresh, replicas with a last-known-good ruleset serve it
 * without touching storage for this long — otherwise every request during a
 * storage outage pays full storage-retry latency. Cold start (no state)
 * keeps retrying eagerly since it fails closed until a load succeeds.
 */
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;
/**
 * How often a warm replica probes the generation sentinel's ETag between
 * full refreshes. A changed sentinel (another replica served an admin
 * write) triggers an immediate refetch, so cross-replica propagation drops
 * from ≤RULES_CACHE_TTL_MS to roughly this interval. The probe is a single
 * tiny-blob read; on any probe failure (or a deployment whose sentinel was
 * never written) behavior degrades to exactly the pre-sentinel TTL bound.
 */
const GENERATION_PROBE_INTERVAL_MS = 5_000;

export type AccessDecisionKind = 'allow' | 'deny' | 'unavailable';

export interface AgentAccessDecision {
  decision: AccessDecisionKind;
  /**
   * Machine-readable cause: 'feature-disabled' | 'no-rule' | 'public' |
   * 'allow-user' | 'allow-domain' | 'no-user-mail' | 'not-allowed' |
   * 'rules-unavailable' | 'unresolved-source:<inner reason>' |
   * 'unresolved-source-all-rules-satisfied'.
   */
  reason: string;
}

export interface EvaluateAccessInput {
  /** session.user.mail — undefined denies access to restricted agents. */
  userMail: string | undefined;
  /**
   * ARM source path the agent was resolved from. null/undefined/blank means
   * the source could not be resolved: the user must then satisfy EVERY rule
   * matching this agentName under ANY source (spec semantics #4).
   */
  source: string | null | undefined;
  agentName: string;
}

export interface AgentAccessSnapshot {
  rules: StoredAgentAccessRule[];
  config: AgentAccessConfig | null;
  configEtag: string | null;
  /** Prompt-agent personas; empty when the feature is off or never loaded. */
  promptAgents: PromptAgent[];
  /** Admin MCP connectors; empty when the feature is off or never loaded. */
  connectors: McpConnector[];
  /** Admin catalog OAuth apps; empty when the feature is off or never loaded. */
  catalogOauthApps: CatalogOauthApp[];
  /** Admin workflow guides; empty when the feature is off or never loaded. */
  guides: Guide[];
  /** M365 file-backed agents; empty when the feature is off or never loaded. */
  m365Agents: M365Agent[];
  /** Admin org RAG agents; empty when the feature is off or never loaded. */
  orgAgents: OrgRagAgent[];
  /** Enabled + no last-known-good ruleset (cold start + storage outage). */
  rulesUnavailable: boolean;
  /** Epoch ms of the last successful refresh; null when never loaded. */
  fetchedAt: number | null;
}

export interface AccessAuditEntry {
  userMail: string | undefined;
  agentName: string;
  source: string | null | undefined;
  decision: AccessDecisionKind;
  reason: string;
  /**
   * When the session user is available the decision is ALSO emitted as a
   * queryable `AgentAccess` event in Azure Monitor (console line always).
   */
  user?: Session['user'];
  telemetry?: RequestTelemetry;
}

/**
 * Structured audit line for every allow/deny decision at the invocation
 * guard (`agent-access-audit`). All fields are sanitized against log
 * injection.
 */
export function emitAccessAudit(entry: AccessAuditEntry): void {
  console.log(
    `[agent-access-audit] decision=${entry.decision} reason=${sanitizeForLog(entry.reason)} ` +
      `user=${sanitizeForLog(entry.userMail ?? '<none>')} agent=${sanitizeForLog(entry.agentName)} ` +
      `source=${sanitizeForLog(entry.source ?? '<unresolved>')}`,
  );
  if (entry.user) {
    // Fire-and-forget; a telemetry failure must never affect the decision.
    void getAzureMonitorLogger()
      .logAgentAccess({
        user: entry.user,
        agentName: entry.agentName,
        agentSource: entry.source,
        decision: entry.decision,
        reason: entry.reason,
        telemetry: entry.telemetry,
      })
      .catch(() => undefined);
  }
}

interface LoadedState {
  rules: StoredAgentAccessRule[];
  rulesByKey: Map<string, StoredAgentAccessRule>;
  /** Canonicalized agentName → all rules for that name under any source. */
  rulesByAgentName: Map<string, StoredAgentAccessRule[]>;
  config: AgentAccessConfig | null;
  configEtag: string | null;
  promptAgents: PromptAgent[];
  promptAgentsById: Map<string, PromptAgent>;
  connectors: McpConnector[];
  connectorsById: Map<string, McpConnector>;
  catalogOauthApps: CatalogOauthApp[];
  catalogOauthAppsById: Map<string, CatalogOauthApp>;
  guides: Guide[];
  guidesById: Map<string, Guide>;
  m365Agents: M365Agent[];
  m365AgentsById: Map<string, M365Agent>;
  orgAgents: OrgRagAgent[];
  orgAgentsById: Map<string, OrgRagAgent>;
}

export class AgentAccessService {
  private static instance: AgentAccessService | null = null;

  private storage: BlobStorage | null = null;
  /** Last-known-good state; kept on refresh failure. */
  private state: LoadedState | null = null;
  private fetchedAt = 0;
  /**
   * Invalidation generation counter. `invalidate()` bumps it; a completing
   * refresh only stamps `fetchedAt` when the epoch it captured at entry is
   * still current, so an invalidation landing during an in-flight refresh is
   * never lost under a stale-but-freshly-stamped snapshot.
   */
  private epoch = 0;
  /** Epoch ms of the last failed refresh; 0 when none (or cleared). */
  private lastRefreshFailureAt = 0;
  private refreshInFlight: Promise<void> | null = null;
  /** Sentinel ETag observed at the last full refresh; null = never read. */
  private lastGenerationEtag: string | null = null;
  /** Epoch ms of the last sentinel probe (throttles to the probe interval). */
  private generationProbedAt = 0;
  private generationProbeInFlight: Promise<boolean> | null = null;

  static getInstance(): AgentAccessService {
    if (!AgentAccessService.instance) {
      AgentAccessService.instance = new AgentAccessService();
    }
    return AgentAccessService.instance;
  }

  isEnabled(): boolean {
    return env.AGENT_ACCESS_CONTROL_ENABLED;
  }

  /**
   * Refreshes the cached ruleset when the 60s TTL has expired (single-flight;
   * concurrent callers share one refresh). Never throws: failures keep the
   * last-known-good state and are reported through evaluateAccess /
   * getSnapshot as 'unavailable' only when no state was ever loaded.
   */
  async ensureFresh(): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.state && Date.now() - this.fetchedAt < RULES_CACHE_TTL_MS) {
      // Warm snapshot: probe the generation sentinel (throttled) so another
      // replica's admin write is picked up in ~GENERATION_PROBE_INTERVAL_MS
      // instead of waiting out the TTL. An unchanged (or unreadable)
      // sentinel keeps serving the warm snapshot — the TTL stays the
      // correctness backstop either way.
      if (Date.now() - this.generationProbedAt < GENERATION_PROBE_INTERVAL_MS) {
        return;
      }
      const changed = await this.probeGenerationChanged();
      if (!changed) return;
      this.fetchedAt = 0; // fall through to a full refresh below
    }
    if (
      this.state &&
      this.lastRefreshFailureAt !== 0 &&
      Date.now() - this.lastRefreshFailureAt < REFRESH_FAILURE_COOLDOWN_MS
    ) {
      // Storage just failed and we have a last-known-good ruleset: serve it
      // without retrying storage until the cooldown elapses.
      return;
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    await this.refreshInFlight;
  }

  /**
   * Forces the next ensureFresh() to refetch (called after admin writes on
   * the replica that served the write). The last-known-good state is kept so
   * a refetch failure does not degrade to 'unavailable'. Bumping the epoch
   * makes any refresh already in flight complete WITHOUT stamping freshness
   * (it started before the write and may carry pre-write data), so the next
   * ensureFresh() refetches. The write that triggered the invalidation just
   * reached storage, so the failure cooldown is cleared to retry immediately.
   */
  invalidate(): void {
    this.epoch += 1;
    this.fetchedAt = 0;
    this.lastRefreshFailureAt = 0;
    // Fire-and-forget sentinel bump so OTHER replicas pick this write up at
    // the probe interval instead of the full TTL. Best-effort by design: a
    // failed bump costs cross-replica latency (≤TTL — exactly the
    // pre-sentinel bound), never correctness, and must not fail or slow the
    // admin write that triggered it.
    void this.bumpGenerationBestEffort();
  }

  private async bumpGenerationBestEffort(): Promise<void> {
    try {
      await bumpGeneration(this.getStorage());
    } catch (error) {
      console.error(
        `[agent-access] generation sentinel bump failed (other replicas fall back to the ${RULES_CACHE_TTL_MS / 1000}s TTL): ${sanitizeForLog(error)}`,
      );
    }
  }

  /**
   * Reads the sentinel ETag (single-flight) and reports whether it moved
   * since the last full refresh. Errors and a missing sentinel report
   * `false` — the TTL backstop then governs, exactly as before the
   * sentinel existed.
   */
  private async probeGenerationChanged(): Promise<boolean> {
    if (!this.generationProbeInFlight) {
      this.generationProbeInFlight = (async () => {
        try {
          const etag = await readGenerationEtag(this.getStorage());
          this.generationProbedAt = Date.now();
          if (etag === null) return false;
          if (this.lastGenerationEtag === null) {
            // Older snapshot predates sentinel tracking: adopt the current
            // value as the baseline rather than treating it as a change.
            this.lastGenerationEtag = etag;
            return false;
          }
          return etag !== this.lastGenerationEtag;
        } catch {
          this.generationProbedAt = Date.now();
          return false;
        }
      })().finally(() => {
        this.generationProbeInFlight = null;
      });
    }
    return this.generationProbeInFlight;
  }

  /** Cached snapshot for the admin API (rules + etags + config). */
  getSnapshot(): AgentAccessSnapshot {
    return {
      rules: this.state?.rules ?? [],
      config: this.state?.config ?? null,
      configEtag: this.state?.configEtag ?? null,
      promptAgents: this.state?.promptAgents ?? [],
      connectors: this.state?.connectors ?? [],
      catalogOauthApps: this.state?.catalogOauthApps ?? [],
      guides: this.state?.guides ?? [],
      m365Agents: this.state?.m365Agents ?? [],
      orgAgents: this.state?.orgAgents ?? [],
      rulesUnavailable: this.isEnabled() && this.state === null,
      fetchedAt: this.state ? this.fetchedAt : null,
    };
  }

  /** Prompt agents from the cached snapshot — callers ensureFresh() first. */
  getPromptAgents(): PromptAgent[] {
    if (!this.isEnabled()) return [];
    return this.state?.promptAgents ?? [];
  }

  /** Single prompt agent by immutable id; null when unknown (or feature off). */
  getPromptAgentById(id: string): PromptAgent | null {
    if (!this.isEnabled()) return null;
    return this.state?.promptAgentsById.get(id) ?? null;
  }

  /** Admin MCP connectors from the cached snapshot — callers ensureFresh() first. */
  getConnectors(): McpConnector[] {
    if (!this.isEnabled()) return [];
    return this.state?.connectors ?? [];
  }

  /**
   * Single connector by immutable id; null when unknown (or feature off).
   *
   * Returning null when the feature is disabled is deliberate and differs from
   * evaluateAccess's 'feature-disabled' → allow: an access RULE that cannot be
   * consulted should not block an otherwise-configured agent, but a connector
   * that cannot be loaded has no URL, and inventing one is not an option.
   */
  getConnectorById(id: string): McpConnector | null {
    if (!this.isEnabled()) return null;
    return this.state?.connectorsById.get(id) ?? null;
  }

  /**
   * Admin-configured OAuth app for one curated catalog key (github, asana,
   * …); null when none is stored (callers fall back to the MCP_OAUTH_* env
   * vars) or when the feature is off. Same contract as getConnectorById.
   */
  getCatalogOauthApp(catalogKey: string): CatalogOauthApp | null {
    if (!this.isEnabled()) return null;
    return this.state?.catalogOauthAppsById.get(catalogKey) ?? null;
  }

  /** Admin workflow guides from the cached snapshot — callers ensureFresh() first. */
  getGuides(): Guide[] {
    if (!this.isEnabled()) return [];
    return this.state?.guides ?? [];
  }

  /**
   * Single guide by immutable id; null when unknown (or feature off).
   *
   * Same contract as getConnectorById: a guide that cannot be loaded has no
   * body, and inventing one is not an option — so feature-off returns null
   * and assess requests referencing the id fail closed.
   */
  getGuideById(id: string): Guide | null {
    if (!this.isEnabled()) return null;
    return this.state?.guidesById.get(id) ?? null;
  }

  /** M365 agents from the cached snapshot — callers ensureFresh() first. */
  getM365Agents(): M365Agent[] {
    if (!this.isEnabled()) return [];
    return this.state?.m365Agents ?? [];
  }

  /**
   * Single M365 agent by immutable id; null when unknown (or feature off).
   *
   * Same contract as getConnectorById: an agent that cannot be loaded has no
   * sources or index filter, and inventing one is not an option — so
   * feature-off returns null and invocations referencing the id fall through
   * to vanilla chat (the credential guard has already run at that point).
   */
  getM365AgentById(id: string): M365Agent | null {
    if (!this.isEnabled()) return null;
    return this.state?.m365AgentsById.get(id) ?? null;
  }

  /** Admin org RAG agents from the cached snapshot — callers ensureFresh() first. */
  getOrgAgents(): OrgRagAgent[] {
    if (!this.isEnabled()) return [];
    return this.state?.orgAgents ?? [];
  }

  /**
   * Single admin org RAG agent by immutable id; null when unknown (or
   * feature off). Feature-off null is safe: the registry then falls back to
   * the static config entry (or nothing), never to a half-loaded record.
   */
  getOrgAgentById(id: string): OrgRagAgent | null {
    if (!this.isEnabled()) return null;
    return this.state?.orgAgentsById.get(id) ?? null;
  }

  /**
   * Synchronous evaluation over the cached snapshot — callers must await
   * ensureFresh() first. Implements spec semantics 1–5.
   */
  evaluateAccess(input: EvaluateAccessInput): AgentAccessDecision {
    if (!this.isEnabled()) {
      return { decision: 'allow', reason: 'feature-disabled' };
    }
    if (!this.state) {
      // Enabled but no last-known-good: callers fail closed at invocation
      // and pass through at discovery (spec semantics #5).
      return { decision: 'unavailable', reason: 'rules-unavailable' };
    }

    const source = input.source?.trim();
    if (source) {
      const stored = this.state.rulesByKey.get(
        canonicalAgentKey(source, input.agentName),
      );
      if (!stored) {
        // Deny-list semantics: no rule → allow (spec semantics #1).
        return { decision: 'allow', reason: 'no-rule' };
      }
      return this.evaluateRule(stored, input.userMail);
    }

    // Unresolved source: must satisfy EVERY rule for this agentName under
    // ANY source — closes the omit-the-source-path bypass (semantics #4).
    const agentNameKey = input.agentName.trim().toLowerCase();
    const candidates = this.state.rulesByAgentName.get(agentNameKey) ?? [];
    if (candidates.length === 0) {
      return { decision: 'allow', reason: 'no-rule' };
    }
    for (const stored of candidates) {
      const result = this.evaluateRule(stored, input.userMail);
      if (result.decision !== 'allow') {
        return {
          decision: 'deny',
          reason: `unresolved-source:${result.reason}`,
        };
      }
    }
    return {
      decision: 'allow',
      reason: 'unresolved-source-all-rules-satisfied',
    };
  }

  private evaluateRule(
    stored: StoredAgentAccessRule,
    userMail: string | undefined,
  ): AgentAccessDecision {
    const access = stored.rule.access;
    if (access.type === 'public') {
      return { decision: 'allow', reason: 'public' };
    }
    if (!userMail) {
      // Missing Graph mail → deny for restricted agents (semantics #2).
      return { decision: 'deny', reason: 'no-user-mail' };
    }
    // Targeting semantics are shared with usage limits (see
    // lib/services/shared/principalMatching.ts) so the two features can never
    // disagree about what "this user matches this rule" means. Group ids
    // come from the process-level membership cache (warmed per request by
    // the calling route) — cold cache means no group grants, never an
    // error, matching the pre-§5 posture.
    const principal: Principal = {
      userId: '',
      mail: normalizeMail(userMail),
      domain: domainOfMail(userMail),
      attributes: [],
      groupIds: getCachedGroupIdsForMail(userMail),
    };
    if (matchesPrincipal(principal, 'user', access.allowUsers)) {
      return { decision: 'allow', reason: 'allow-user' };
    }
    if (matchesPrincipal(principal, 'domain', access.allowDomains)) {
      return { decision: 'allow', reason: 'allow-domain' };
    }
    if (matchesPrincipal(principal, 'group', access.allowGroups)) {
      return { decision: 'allow', reason: 'allow-group' };
    }
    return { decision: 'deny', reason: 'not-allowed' };
  }

  private getStorage(): BlobStorage {
    if (!this.storage) {
      this.storage = createAgentAccessBlobStorage();
    }
    return this.storage;
  }

  private async refresh(): Promise<void> {
    const epochAtEntry = this.epoch;
    try {
      const storage = this.getStorage();
      // The sentinel ETag read is ISSUED before the listings (awaited at the
      // end): a bump landing after this point differs from the stamped
      // value, so the next probe refetches — the same never-lose-a-write
      // reasoning as the epoch check on fetchedAt below. Best-effort: a
      // failed read keeps the previous baseline and the TTL backstop
      // governs.
      let generationEtagPromise: Promise<string | null>;
      try {
        generationEtagPromise = readGenerationEtag(storage).then(
          (etag) => etag,
          () => this.lastGenerationEtag,
        );
      } catch {
        generationEtagPromise = Promise.resolve(this.lastGenerationEtag);
      }
      // Rules and config load in one transaction: that pair is kept/replaced
      // atomically, so a failure in either keeps last-known-good for both
      // (never a mixed-age rules/config pair). Prompt agents load in a
      // separate, independently-degradable step below — a persona-listing
      // failure must never freeze rule propagation or mark rules
      // unavailable (a broken persona degrades only itself; access
      // enforcement depends on rules/config alone).
      const rules = await listAllRules(storage);
      const configResult = await readConfig(storage);

      const rulesByKey = new Map<string, StoredAgentAccessRule>();
      const rulesByAgentName = new Map<string, StoredAgentAccessRule[]>();
      for (const stored of rules) {
        rulesByKey.set(stored.canonicalKey, stored);
        const nameKey = stored.rule.agentName.trim().toLowerCase();
        const list = rulesByAgentName.get(nameKey);
        if (list) {
          list.push(stored);
        } else {
          rulesByAgentName.set(nameKey, [stored]);
        }
      }

      // Prompt agents: isolated failure handling. On failure the persona
      // half keeps its own last-known-good (empty on cold start) and the
      // rules snapshot still commits — the failure is logged loudly but is
      // never reported as 'unavailable'.
      let promptAgents: PromptAgent[] = this.state?.promptAgents ?? [];
      let promptAgentsById: Map<string, PromptAgent> =
        this.state?.promptAgentsById ?? new Map();
      try {
        const storedPromptAgents = await listAllPromptAgents(storage);
        promptAgents = storedPromptAgents.map(
          (stored: StoredPromptAgent) => stored.agent,
        );
        promptAgentsById = new Map<string, PromptAgent>(
          promptAgents.map((agent) => [agent.id, agent]),
        );
      } catch (error) {
        console.error(
          `[agent-access] prompt-agent listing failed (${
            this.state
              ? 'keeping last-known-good personas'
              : 'no personas until a load succeeds'
          }; rules snapshot unaffected): ${sanitizeForLog(error)}`,
        );
      }

      // Connectors: same isolated-failure contract as personas. Note the
      // direction this degrades in — a listing failure leaves connectors
      // ABSENT, and an absent connector resolves to nothing at chat time
      // rather than to an unguarded URL. Failing to load is therefore failing
      // closed, which is why it need not mark the snapshot unavailable.
      let connectors: McpConnector[] = this.state?.connectors ?? [];
      let connectorsById: Map<string, McpConnector> =
        this.state?.connectorsById ?? new Map();
      try {
        const storedConnectors = await listAllConnectors(storage);
        connectors = storedConnectors.map(
          (stored: StoredMcpConnector) => stored.connector,
        );
        connectorsById = new Map<string, McpConnector>(
          connectors.map((connector) => [connector.id, connector]),
        );
      } catch (error) {
        console.error(
          `[agent-access] connector listing failed (${
            this.state
              ? 'keeping last-known-good connectors'
              : 'no connectors until a load succeeds'
          }; rules snapshot unaffected): ${sanitizeForLog(error)}`,
        );
      }

      // Catalog OAuth apps: same isolated-failure contract as connectors.
      // A listing failure keeps last-known-good records; an absent record
      // falls back to the env-var OAuth client, so this too fails closed
      // (never to a wrong credential).
      let catalogOauthApps: CatalogOauthApp[] =
        this.state?.catalogOauthApps ?? [];
      let catalogOauthAppsById: Map<string, CatalogOauthApp> =
        this.state?.catalogOauthAppsById ?? new Map();
      try {
        const storedApps = await listAllCatalogOauthApps(storage);
        catalogOauthApps = storedApps.map((stored) => stored.app);
        catalogOauthAppsById = new Map<string, CatalogOauthApp>(
          catalogOauthApps.map((app) => [app.id, app]),
        );
      } catch (error) {
        console.error(
          `[agent-access] catalog-oauth-app listing failed (${
            this.state
              ? 'keeping last-known-good records'
              : 'env-var fallback until a load succeeds'
          }; rules snapshot unaffected): ${sanitizeForLog(error)}`,
        );
      }

      // Guides: same isolated-failure contract as personas and connectors.
      // A listing failure leaves guides ABSENT — an absent guide rejects the
      // assess request that references it rather than injecting an unknown
      // body, so failing to load is failing closed and need not mark the
      // snapshot unavailable.
      let guides: Guide[] = this.state?.guides ?? [];
      let guidesById: Map<string, Guide> = this.state?.guidesById ?? new Map();
      try {
        const storedGuides = await listAllGuides(storage);
        guides = storedGuides.map((stored: StoredGuide) => stored.guide);
        guidesById = new Map<string, Guide>(
          guides.map((guide) => [guide.id, guide]),
        );
      } catch (error) {
        console.error(
          `[agent-access] guide listing failed (${
            this.state
              ? 'keeping last-known-good guides'
              : 'no guides until a load succeeds'
          }; rules snapshot unaffected): ${sanitizeForLog(error)}`,
        );
      }

      // M365 agents: same isolated-failure contract as personas, connectors
      // and guides. A listing failure leaves the agents ABSENT — an absent
      // agent falls through to vanilla chat rather than exposing indexed
      // content, so failing to load is failing closed and need not mark the
      // snapshot unavailable.
      let m365Agents: M365Agent[] = this.state?.m365Agents ?? [];
      let m365AgentsById: Map<string, M365Agent> =
        this.state?.m365AgentsById ?? new Map();
      try {
        const storedM365Agents = await listAllM365Agents(storage);
        m365Agents = storedM365Agents.map(
          (stored: StoredM365Agent) => stored.m365Agent,
        );
        m365AgentsById = new Map<string, M365Agent>(
          m365Agents.map((agent) => [agent.id, agent]),
        );
      } catch (error) {
        console.error(
          `[agent-access] m365-agent listing failed (${
            this.state
              ? 'keeping last-known-good agents'
              : 'no m365 agents until a load succeeds'
          }; rules snapshot unaffected): ${sanitizeForLog(error)}`,
        );
      }

      // Org RAG agents: same isolated-failure contract as the entities
      // above. A listing failure leaves the admin records ABSENT — the
      // registry then serves the static config file (last-known-good by
      // definition) or nothing, so failing to load is failing safe and need
      // not mark the snapshot unavailable.
      let orgAgents: OrgRagAgent[] = this.state?.orgAgents ?? [];
      let orgAgentsById: Map<string, OrgRagAgent> =
        this.state?.orgAgentsById ?? new Map();
      try {
        const storedOrgAgents = await listAllOrgAgents(storage);
        orgAgents = storedOrgAgents.map(
          (stored: StoredOrgRagAgent) => stored.orgAgent,
        );
        orgAgentsById = new Map<string, OrgRagAgent>(
          orgAgents.map((agent) => [agent.id, agent]),
        );
      } catch (error) {
        console.error(
          `[agent-access] org-agent listing failed (${
            this.state
              ? 'keeping last-known-good agents'
              : 'no org agents until a load succeeds'
          }; rules snapshot unaffected): ${sanitizeForLog(error)}`,
        );
      }

      // Keeping the fetched state is always safe — it is never older than
      // what it replaces — but freshness is only stamped when no
      // invalidate() landed while this refresh was in flight. Otherwise
      // fetchedAt stays 0 and the next ensureFresh() refetches, so the
      // replica that just wrote never serves pre-write rules for a full TTL.
      this.state = {
        rules,
        rulesByKey,
        rulesByAgentName,
        config: configResult?.config ?? null,
        configEtag: configResult?.etag ?? null,
        promptAgents,
        promptAgentsById,
        connectors,
        connectorsById,
        catalogOauthApps,
        catalogOauthAppsById,
        guides,
        guidesById,
        m365Agents,
        m365AgentsById,
        orgAgents,
        orgAgentsById,
      };
      this.lastGenerationEtag = await generationEtagPromise;
      this.lastRefreshFailureAt = 0;
      this.fetchedAt = this.epoch === epochAtEntry ? Date.now() : 0;
    } catch (error) {
      this.lastRefreshFailureAt = Date.now();
      console.error(
        `[agent-access] rules refresh failed (${
          this.state
            ? 'serving last-known-good'
            : 'NO last-known-good — invocation fails closed'
        }): ${sanitizeForLog(error)}`,
      );
    }
  }
}
