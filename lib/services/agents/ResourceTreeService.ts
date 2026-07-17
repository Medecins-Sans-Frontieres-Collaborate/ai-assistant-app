/**
 * Resource Tree Service
 *
 * Maps the full subscription → AIServices account → project tree via the
 * Azure Resource Manager (ARM) API, pruning branches that contain no Foundry
 * projects. Results are RBAC-filtered because the user's OBO token is used.
 *
 * Backs the `level=tree` mode of /api/agents/browse so the connect-source
 * picker can show only locations that actually lead somewhere, instead of
 * making the user walk a lazy cascade full of dead ends.
 */
import { createHash } from 'crypto';

const ARM_BASE = 'https://management.azure.com';
const SUBSCRIPTIONS_API_VERSION = '2022-01-01';
const ACCOUNTS_API_VERSION = '2025-12-01';

// Enumeration bounds. Worst case 1 + 50 + 100 = 151 ARM reads per cold load,
// far under ARM's ~12k reads/hr/principal budget — these caps exist for
// latency, not quota. Exceeding either sets `truncated` so the UI can warn
// instead of silently dropping resources.
const MAX_SUBSCRIPTIONS = 50;
const MAX_ACCOUNT_FANOUT = 100;
const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 10_000;

// 5 minutes: the tree backs an interactive picker, so a modal reopen should
// be instant but newly created projects should appear quickly. Much shorter
// than the 1h agent-list TTL in AgentDiscoveryService because tree loads only
// happen while the connect-source form is open.
const CACHE_TTL_MS = 5 * 60 * 1000;

interface ArmSubscription {
  subscriptionId: string;
  displayName: string;
}

interface ArmCognitiveAccount {
  name: string;
  kind?: string;
  id: string;
  location?: string;
}

interface ArmProject {
  name: string;
}

export interface FoundryProjectNode {
  name: string;
}

export interface FoundryAccountNode {
  name: string;
  resourceGroup: string;
  location?: string;
  projects: FoundryProjectNode[];
}

export interface FoundrySubscriptionNode {
  id: string;
  name: string;
  accounts: FoundryAccountNode[];
}

export interface FoundryResourceTree {
  /** Pruned: only subscriptions/accounts with at least one project. */
  subscriptions: FoundrySubscriptionNode[];
  /** Subscriptions whose account enumeration failed (shown as a warning). */
  failedSubscriptions: { id: string; name: string }[];
  /** True when MAX_SUBSCRIPTIONS or MAX_ACCOUNT_FANOUT was exceeded. */
  truncated: boolean;
}

interface CachedTree {
  tree: FoundryResourceTree;
  expiresAt: number;
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export class ResourceTreeService {
  private static instance: ResourceTreeService | null = null;
  private cache = new Map<string, CachedTree>();

  static getInstance(): ResourceTreeService {
    if (!ResourceTreeService.instance) {
      ResourceTreeService.instance = new ResourceTreeService();
    }
    return ResourceTreeService.instance;
  }

  /**
   * Builds the pruned Foundry resource tree visible to the given ARM token.
   * A subscription that fails to enumerate lands in `failedSubscriptions`
   * rather than failing the whole tree; a failed per-account projects call
   * just prunes that account.
   */
  async getTree(armToken: string): Promise<FoundryResourceTree> {
    const cacheKey = this.hashKey(armToken);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.tree;
    }

    let truncated = false;

    const subsData = await this.armGet<ArmSubscription>(
      armToken,
      new URL(
        `/subscriptions?api-version=${SUBSCRIPTIONS_API_VERSION}`,
        ARM_BASE,
      ),
    );
    let subscriptions = subsData.value.map((s) => ({
      id: s.subscriptionId,
      name: s.displayName,
    }));
    if (subscriptions.length > MAX_SUBSCRIPTIONS) {
      subscriptions = subscriptions.slice(0, MAX_SUBSCRIPTIONS);
      truncated = true;
    }

    const failedSubscriptions: { id: string; name: string }[] = [];

    // Phase 1: one accounts call per subscription (the list is
    // subscription-wide, so no per-resource-group fan-out is needed).
    const accountsBySub = await mapWithConcurrency(
      subscriptions,
      CONCURRENCY,
      async (sub) => {
        try {
          const data = await this.armGet<ArmCognitiveAccount>(
            armToken,
            new URL(
              `/subscriptions/${encodeURIComponent(sub.id)}/providers/Microsoft.CognitiveServices/accounts?api-version=${ACCOUNTS_API_VERSION}`,
              ARM_BASE,
            ),
          );
          return data.value
            .filter((a) => a.kind === 'AIServices')
            .map((a) => ({
              subscription: sub,
              name: a.name,
              resourceGroup: a.id.split('/resourceGroups/')[1]?.split('/')[0],
              location: a.location,
            }))
            .filter(
              (a): a is typeof a & { resourceGroup: string } =>
                !!a.resourceGroup,
            );
        } catch (e) {
          console.error(
            `[ResourceTreeService] Failed to list accounts for subscription ${sub.id}:`,
            e instanceof Error ? e.message : e,
          );
          failedSubscriptions.push(sub);
          return [];
        }
      },
    );

    let flatAccounts = accountsBySub.flat();
    if (flatAccounts.length > MAX_ACCOUNT_FANOUT) {
      flatAccounts = flatAccounts.slice(0, MAX_ACCOUNT_FANOUT);
      truncated = true;
    }

    // Phase 2: one projects call per AIServices account. A failure prunes
    // just that account (treated as empty).
    const accountNodes = await mapWithConcurrency(
      flatAccounts,
      CONCURRENCY,
      async (account) => {
        let projects: FoundryProjectNode[] = [];
        try {
          const data = await this.armGet<ArmProject>(
            armToken,
            new URL(
              `/subscriptions/${encodeURIComponent(account.subscription.id)}/resourceGroups/${encodeURIComponent(account.resourceGroup)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(account.name)}/projects?api-version=${ACCOUNTS_API_VERSION}`,
              ARM_BASE,
            ),
          );
          projects = data.value
            .map((p) => ({ name: p.name.split('/').pop() ?? '' }))
            .filter((p) => p.name);
        } catch (e) {
          console.error(
            `[ResourceTreeService] Failed to list projects for account ${account.name}:`,
            e instanceof Error ? e.message : e,
          );
        }
        return { account, projects };
      },
    );

    // Assemble + prune: drop accounts with no projects, then subscriptions
    // with no accounts.
    const bySubscription = new Map<string, FoundrySubscriptionNode>();
    for (const sub of subscriptions) {
      bySubscription.set(sub.id, { ...sub, accounts: [] });
    }
    for (const { account, projects } of accountNodes) {
      if (projects.length === 0) continue;
      bySubscription.get(account.subscription.id)?.accounts.push({
        name: account.name,
        resourceGroup: account.resourceGroup,
        location: account.location,
        projects,
      });
    }

    const tree: FoundryResourceTree = {
      subscriptions: [...bySubscription.values()].filter(
        (s) => s.accounts.length > 0,
      ),
      failedSubscriptions,
      truncated,
    };

    this.cache.set(cacheKey, {
      tree,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    console.log(
      `[ResourceTreeService] Tree: ${tree.subscriptions.length} subscriptions with projects, ` +
        `${failedSubscriptions.length} failed, truncated=${truncated}`,
    );

    return tree;
  }

  /**
   * Defense-in-depth: URLs are built from constants + encoded IDs, but pin
   * the origin to ARM so enumeration can never be redirected to another host
   * (SSRF) even if a caller were later loosened. Throws on non-OK so callers
   * can distinguish a failed branch from an empty one.
   */
  private async armGet<T>(token: string, url: URL): Promise<{ value: T[] }> {
    if (url.origin !== ARM_BASE) {
      throw new Error(`Blocked non-ARM URL: ${url.origin}`);
    }
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ARM ${response.status}: ${body.substring(0, 200)}`);
    }
    const data = (await response.json()) as { value?: T[] };
    return { value: data.value ?? [] };
  }

  /**
   * Per-user trust boundary — digest the FULL token with SHA-256 so one
   * user's RBAC-filtered tree can never be served to another (same rationale
   * as AgentDiscoveryService.hashKey).
   */
  private hashKey(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Clears all cached trees. Used when the user explicitly refreshes. */
  clearCache(): void {
    this.cache.clear();
  }

  static reset(): void {
    ResourceTreeService.instance = null;
  }
}
