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
  StoredMcpConnector,
  StoredPromptAgent,
  createAgentAccessBlobStorage,
  listAllConnectors,
  listAllGuides,
  listAllPromptAgents,
  listAllRules,
  readConfig,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AgentAccessConfig,
  Guide,
  McpConnector,
  PromptAgent,
} from '@/lib/services/agentAccess/types';
import { canonicalAgentKey } from '@/lib/services/agentAccess/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';

const RULES_CACHE_TTL_MS = 60_000;
/**
 * After a failed refresh, replicas with a last-known-good ruleset serve it
 * without touching storage for this long — otherwise every request during a
 * storage outage pays full storage-retry latency. Cold start (no state)
 * keeps retrying eagerly since it fails closed until a load succeeds.
 */
const REFRESH_FAILURE_COOLDOWN_MS = 5_000;

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
  /** Admin workflow guides; empty when the feature is off or never loaded. */
  guides: Guide[];
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
  guides: Guide[];
  guidesById: Map<string, Guide>;
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
  /** Dedupes the allowGroups scaffold warning to one line per key per process. */
  private warnedGroupKeys = new Set<string>();

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
    if (this.state && Date.now() - this.fetchedAt < RULES_CACHE_TTL_MS) return;
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
  }

  /** Cached snapshot for the admin API (rules + etags + config). */
  getSnapshot(): AgentAccessSnapshot {
    return {
      rules: this.state?.rules ?? [],
      config: this.state?.config ?? null,
      configEtag: this.state?.configEtag ?? null,
      promptAgents: this.state?.promptAgents ?? [],
      connectors: this.state?.connectors ?? [],
      guides: this.state?.guides ?? [],
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
    if (
      access.allowGroups.length > 0 &&
      !this.warnedGroupKeys.has(stored.canonicalKey)
    ) {
      this.warnedGroupKeys.add(stored.canonicalKey);
      console.warn(
        `[agent-access] rule ${sanitizeForLog(stored.canonicalKey)} has allowGroups, ` +
          'which are NOT evaluated in v1 and grant nothing',
      );
    }
    if (access.type === 'public') {
      return { decision: 'allow', reason: 'public' };
    }
    if (!userMail) {
      // Missing Graph mail → deny for restricted agents (semantics #2).
      return { decision: 'deny', reason: 'no-user-mail' };
    }
    const mail = userMail.trim().toLowerCase();
    if (access.allowUsers.some((u) => u.trim().toLowerCase() === mail)) {
      return { decision: 'allow', reason: 'allow-user' };
    }
    const atIndex = mail.lastIndexOf('@');
    const domain = atIndex >= 0 ? mail.slice(atIndex + 1) : '';
    if (
      domain &&
      access.allowDomains.some((d) => d.trim().toLowerCase() === domain)
    ) {
      return { decision: 'allow', reason: 'allow-domain' };
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
        guides,
        guidesById,
      };
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
