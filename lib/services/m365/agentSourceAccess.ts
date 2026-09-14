/**
 * Layer-2 content-access checks for M365 file-backed agents.
 *
 * Layer 1 (may the user see the agent?) is the normal AgentAccessService
 * rule; THIS module answers layer 2: may the requesting user read the base
 * files? The source of truth is Microsoft Graph evaluated with the
 * REQUESTING USER'S own delegated token — never the creator's — via cheap
 * metadata-only probes (`$select=id`). Retrieval is then hard-filtered to
 * the accessible subset, so indexed content can never leak past what Graph
 * would allow the user directly.
 *
 * Probes run as Graph JSON $batch calls (20 sub-requests per call), so an
 * agent at the 50-document default costs 3 round-trips per user per TTL.
 * Folder sources are trimmed PER INDEXED ITEM: the agent's manifest (what
 * the last index run actually put in the index, recursively) lists the
 * item ids, and each is probed with the user's token — exact for nested
 * files and for children with broken permission inheritance. Folders
 * indexed before manifests existed fall back to one security-trimmed
 * immediate-children listing, matching their snapshot semantics.
 * Verdicts are cached per user+agent for a short TTL (per-process, like the
 * access-rules snapshot): max staleness after a permission revocation in
 * SharePoint is CACHE_TTL_MS. Only DEFINITIVE verdicts are cached: a probe
 * that came back throttled or 5xx fails closed for this request but is
 * not remembered, so a Graph wobble cannot lock a user out for the TTL.
 */
import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  readM365AgentManifest,
} from '@/lib/services/agentAccess/accessRulesStore';
import type {
  M365Agent,
  M365AgentSource,
} from '@/lib/services/agentAccess/types';
import type { AccessibleFolderItem } from '@/lib/services/m365/agentIndexService';
import { graphJson, withGraphTokenCache } from '@/lib/services/m365/graphApi';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const GRAPH_SCOPES = ['Files.ReadWrite.All'];
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 2000;
/** Graph JSON batching allows at most 20 sub-requests per call. */
const GRAPH_BATCH_SIZE = 20;
/** Legacy (pre-manifest) folder expansion page — immediate children only. */
const FOLDER_CHILD_PAGE = 200;
/** Manifests change only on index runs; a short per-process cache suffices. */
const MANIFEST_CACHE_TTL_MS = 60_000;

export interface SourceAccessResult {
  sourceId: string;
  accessible: boolean;
}

export interface AgentSourceAccess {
  /** Sources the user's own token can currently open. */
  accessibleSourceIds: string[];
  /**
   * True when at least one verdict could not be established (Graph
   * throttled or errored on the probe). Denials in `results` may then be
   * transient; callers can say "couldn't verify" instead of "no access".
   * Such a result is never cached.
   */
  unverifiable: boolean;
  /**
   * Child FILES the user can see inside accessible folder sources, each
   * addressed within its drive (item ids are only unique per drive).
   * Folder chunks are trimmed per-item with this list — a folder-level
   * verdict alone would leak children with tighter item-level permissions
   * (broken inheritance) to anyone who can open the folder.
   */
  accessibleFolderItems: AccessibleFolderItem[];
  results: SourceAccessResult[];
}

interface CacheEntry {
  at: number;
  access: AgentSourceAccess;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(userId: string, agent: M365Agent): string {
  // updatedAt in the key: editing sources invalidates naturally.
  return `${userId}:${agent.id}:${agent.updatedAt}`;
}

interface GraphBatchResponseShape {
  responses?: {
    id?: string;
    status?: number;
    headers?: Record<string, string>;
  }[];
}

/**
 * Per-item verdict. `unknown` = Graph gave no definitive answer (throttled
 * even after a retry, 5xx, or the sub-response was missing): treated as
 * inaccessible for THIS request, never cached.
 */
type Verdict = 'ok' | 'denied' | 'unknown';

/** Cap on how long a throttled probe waits before its single retry. */
const PROBE_RETRY_MAX_MS = 10_000;
const PROBE_RETRY_DEFAULT_MS = 1_000;

function retryAfterMs(headers: Record<string, string> | undefined): number {
  const raw = headers
    ? Object.entries(headers).find(
        ([name]) => name.toLowerCase() === 'retry-after',
      )?.[1]
    : undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return PROBE_RETRY_DEFAULT_MS;
  return Math.min(seconds * 1000, PROBE_RETRY_MAX_MS);
}

/**
 * Probes items via $batch. A sub-request's 2xx means the user's token can
 * open the item; 403/404 means it can't. A 429 sub-response is retried
 * ONCE after its Retry-After; anything still not definitive (429 again,
 * 5xx, missing) is `unknown`. Batch-level failures (no session, consent
 * gap, transport) throw for the caller to map to the connect flow.
 */
interface ProbeTarget {
  /** Verdict key (source id, or item id for manifest items). */
  key: string;
  driveId: string;
  itemId: string;
}

async function probeBatch(
  req: NextRequest,
  slice: ProbeTarget[],
): Promise<{
  verdicts: Map<string, Verdict>;
  throttled: ProbeTarget[];
  waitMs: number;
}> {
  const data = await graphJson<GraphBatchResponseShape>(
    req,
    GRAPH_SCOPES,
    '/$batch',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: slice.map((target, index) => ({
          id: String(index),
          method: 'GET',
          url: `/drives/${encodeURIComponent(target.driveId)}/items/${encodeURIComponent(target.itemId)}?$select=id`,
        })),
      }),
    },
  );
  const verdicts = new Map<string, Verdict>();
  const throttled: ProbeTarget[] = [];
  let waitMs = 0;
  for (const response of data.responses ?? []) {
    const target = slice[Number(response.id)];
    if (!target) continue;
    const status = response.status ?? 0;
    if (status >= 200 && status < 300) {
      verdicts.set(target.key, 'ok');
    } else if (status === 403 || status === 404) {
      verdicts.set(target.key, 'denied');
    } else if (status === 429) {
      throttled.push(target);
      waitMs = Math.max(waitMs, retryAfterMs(response.headers));
    } else {
      console.warn(
        `[m365-agents] unexpected probe status ${status} for ${sanitizeForLog(target.key)}; failing closed for this item (not cached)`,
      );
      verdicts.set(target.key, 'unknown');
    }
  }
  return { verdicts, throttled, waitMs };
}

async function probeItems(
  req: NextRequest,
  targets: ProbeTarget[],
): Promise<Map<string, Verdict>> {
  const verdicts = new Map<string, Verdict>(
    targets.map((target) => [target.key, 'unknown' as const]),
  );
  const throttled: ProbeTarget[] = [];
  let waitMs = 0;
  for (let offset = 0; offset < targets.length; offset += GRAPH_BATCH_SIZE) {
    const batch = await probeBatch(
      req,
      targets.slice(offset, offset + GRAPH_BATCH_SIZE),
    );
    for (const [key, verdict] of batch.verdicts) verdicts.set(key, verdict);
    throttled.push(...batch.throttled);
    waitMs = Math.max(waitMs, batch.waitMs);
  }
  if (throttled.length > 0) {
    console.warn(
      `[m365-agents] ${throttled.length} probe(s) throttled; retrying once after ${waitMs}ms`,
    );
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
    for (
      let offset = 0;
      offset < throttled.length;
      offset += GRAPH_BATCH_SIZE
    ) {
      const batch = await probeBatch(
        req,
        throttled.slice(offset, offset + GRAPH_BATCH_SIZE),
      );
      for (const [key, verdict] of batch.verdicts) verdicts.set(key, verdict);
      // Still throttled after the retry: unknown (already the default).
    }
  }
  return verdicts;
}

function probeSources(
  req: NextRequest,
  sources: M365AgentSource[],
): Promise<Map<string, Verdict>> {
  return probeItems(
    req,
    sources.map((source) => ({
      key: source.sourceId,
      driveId: source.driveId,
      itemId: source.itemId,
    })),
  );
}

interface ManifestCacheEntry {
  at: number;
  /** Indexed items per source id; null = no manifest for this agent. */
  bySource: Map<string, ProbeTarget[]> | null;
}

const manifestCache = new Map<string, ManifestCacheEntry>();

/**
 * Indexed item ids per folder source from the agent's manifest. Null when
 * the agent has no manifest (never indexed under the seventh-pass
 * pipeline) or the read fails — callers then use the legacy listing,
 * which is still security-trimmed by the user's own token.
 */
async function loadIndexedItems(
  agent: M365Agent,
): Promise<Map<string, ProbeTarget[]> | null> {
  const cached = manifestCache.get(agent.id);
  if (cached && Date.now() - cached.at < MANIFEST_CACHE_TTL_MS) {
    return cached.bySource;
  }
  let bySource: Map<string, ProbeTarget[]> | null = null;
  try {
    const manifest = await readM365AgentManifest(
      createAgentAccessBlobStorage(),
      agent.id,
    );
    if (manifest) {
      bySource = new Map();
      for (const source of manifest.sources) {
        bySource.set(
          source.sourceId,
          source.items
            .filter((item) => item.status === 'indexed')
            // Graph item ids are unique per DRIVE; a composite key keeps two
            // drives' items from sharing (and widening) a verdict.
            .map((item) => ({
              key: `${item.driveId}:${item.itemId}`,
              driveId: item.driveId,
              itemId: item.itemId,
            })),
        );
      }
    }
  } catch (error) {
    console.warn(
      `[m365-agents] manifest read failed for ${sanitizeForLog(agent.id)}; using legacy folder listing: ${sanitizeForLog(error)}`,
    );
  }
  if (manifestCache.size >= MAX_CACHE_ENTRIES) manifestCache.clear();
  manifestCache.set(agent.id, { at: Date.now(), bySource });
  return bySource;
}

/**
 * Resolves the child files the USER'S OWN token can see inside each
 * accessible folder source. Graph children listings are security-trimmed,
 * so an item-restricted child simply doesn't appear for a user without
 * access. A failed listing or probe fails CLOSED for that folder only,
 * and marks the result `unverifiable` so it is not cached.
 */
async function resolveAccessibleFolderItems(
  req: NextRequest,
  agent: M365Agent,
  folders: M365AgentSource[],
): Promise<{ items: AccessibleFolderItem[]; unverifiable: boolean }> {
  if (folders.length === 0) return { items: [], unverifiable: false };
  const items: AccessibleFolderItem[] = [];
  let unverifiable = false;
  const indexed = await loadIndexedItems(agent);
  const legacyFolders: M365AgentSource[] = [];
  const targets: ProbeTarget[] = [];
  for (const folder of folders) {
    const items = indexed?.get(folder.sourceId);
    if (items) targets.push(...items);
    else legacyFolders.push(folder);
  }
  if (targets.length > 0) {
    try {
      const verdicts = await probeItems(req, targets);
      for (const target of targets) {
        const verdict = verdicts.get(target.key);
        if (verdict === 'ok') {
          items.push({ driveId: target.driveId, itemId: target.itemId });
        } else if (verdict !== 'denied') {
          unverifiable = true;
        }
      }
    } catch (error) {
      // Fail closed for the manifest-backed folders only — and only for
      // this request: a transport failure is not a permission verdict.
      unverifiable = true;
      console.warn(
        `[m365-agents] per-item probe failed for agent ${sanitizeForLog(agent.id)}; failing closed for its folder items: ${sanitizeForLog(error)}`,
      );
    }
  }
  for (const folder of legacyFolders) {
    try {
      const children = await graphJson<{
        value?: { id?: string; folder?: unknown }[];
      }>(
        req,
        GRAPH_SCOPES,
        `/drives/${encodeURIComponent(folder.driveId)}/items/${encodeURIComponent(folder.itemId)}/children` +
          `?$select=id,folder&$top=${FOLDER_CHILD_PAGE}`,
      );
      for (const child of children.value ?? []) {
        if (!child.id || child.folder) continue;
        items.push({ driveId: folder.driveId, itemId: child.id });
      }
    } catch (error) {
      unverifiable = true;
      console.warn(
        `[m365-agents] folder child listing failed for source ${sanitizeForLog(folder.sourceId)}; failing closed for this folder: ${sanitizeForLog(error)}`,
      );
    }
  }
  return { items, unverifiable };
}

/**
 * Checks every source of the agent with the requesting user's token.
 * Throws M365Error('not_connected'|'consent_missing') when the user has no
 * usable Graph session — callers surface the connect flow instead of a
 * denial. Sources absent from the batch response fail closed.
 */
export async function checkAgentSourceAccess(
  req: NextRequest,
  userId: string,
  agent: M365Agent,
): Promise<AgentSourceAccess> {
  const key = cacheKey(userId, agent);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.access;
  }
  // Several $batch calls plus folder listings: one token mint for all.
  return withGraphTokenCache(req, async () => {
    const verdicts = await probeSources(req, agent.sources);
    const results = agent.sources.map(
      (source): SourceAccessResult => ({
        sourceId: source.sourceId,
        accessible: verdicts.get(source.sourceId) === 'ok',
      }),
    );
    let unverifiable = agent.sources.some(
      (source) => (verdicts.get(source.sourceId) ?? 'unknown') === 'unknown',
    );

    const folderItems = await resolveAccessibleFolderItems(
      req,
      agent,
      agent.sources.filter(
        (source) =>
          source.kind === 'folder' && verdicts.get(source.sourceId) === 'ok',
      ),
    );
    unverifiable ||= folderItems.unverifiable;

    const access: AgentSourceAccess = {
      accessibleSourceIds: results
        .filter((r) => r.accessible)
        .map((r) => r.sourceId),
      accessibleFolderItems: folderItems.items,
      results,
      unverifiable,
    };

    if (unverifiable) {
      // Fail closed now, but let the next request ask Graph again.
      console.warn(
        `[m365-agents] source access for agent ${sanitizeForLog(agent.id)} could not be fully verified; verdict not cached`,
      );
      return access;
    }
    if (cache.size >= MAX_CACHE_ENTRIES) {
      // Simple pressure valve; entries are tiny and TTL-bounded anyway.
      cache.clear();
    }
    cache.set(key, { at: Date.now(), access });
    return access;
  });
}

/** Test hook. */
export function clearAgentSourceAccessCache(): void {
  cache.clear();
  manifestCache.clear();
}
