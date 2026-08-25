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
 * SharePoint is CACHE_TTL_MS.
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
import { graphJson } from '@/lib/services/m365/graphApi';

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
  responses?: { id?: string; status?: number }[];
}

/**
 * Probes the sources via $batch. A sub-request's 2xx means the user's token
 * can open the item; 403/404 means it can't. Any OTHER sub-status (429
 * throttle, 5xx) fails CLOSED for that source only — a transient Graph
 * wobble must never widen access, and the verdict retries naturally when
 * the cache entry expires. Batch-level failures (no session, consent gap,
 * transport) throw for the caller to map to the connect flow.
 */
interface ProbeTarget {
  /** Verdict key (source id, or item id for manifest items). */
  key: string;
  driveId: string;
  itemId: string;
}

async function probeItems(
  req: NextRequest,
  targets: ProbeTarget[],
): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>();
  for (let offset = 0; offset < targets.length; offset += GRAPH_BATCH_SIZE) {
    const slice = targets.slice(offset, offset + GRAPH_BATCH_SIZE);
    const data = await graphJson<GraphBatchResponseShape>(
      req,
      GRAPH_SCOPES,
      '/$batch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: slice.map((target, index) => ({
            id: String(offset + index),
            method: 'GET',
            url: `/drives/${encodeURIComponent(target.driveId)}/items/${encodeURIComponent(target.itemId)}?$select=id`,
          })),
        }),
      },
    );
    for (const response of data.responses ?? []) {
      const index = Number(response.id);
      const target = targets[index];
      if (!target) continue;
      const status = response.status ?? 0;
      if (status !== 200 && status !== 403 && status !== 404) {
        console.warn(
          `[m365-agents] unexpected probe status ${status} for ${sanitizeForLog(target.key)}; failing closed for this item`,
        );
      }
      verdicts.set(target.key, status >= 200 && status < 300);
    }
  }
  return verdicts;
}

function probeSources(
  req: NextRequest,
  sources: M365AgentSource[],
): Promise<Map<string, boolean>> {
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
 * access. A failed listing fails CLOSED for that folder only.
 */
async function resolveAccessibleFolderItems(
  req: NextRequest,
  agent: M365Agent,
  folders: M365AgentSource[],
): Promise<AccessibleFolderItem[]> {
  if (folders.length === 0) return [];
  const items: AccessibleFolderItem[] = [];
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
        if (verdicts.get(target.key)) {
          items.push({ driveId: target.driveId, itemId: target.itemId });
        }
      }
    } catch (error) {
      // Fail closed for the manifest-backed folders only.
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
      console.warn(
        `[m365-agents] folder child listing failed for source ${sanitizeForLog(folder.sourceId)}; failing closed for this folder: ${sanitizeForLog(error)}`,
      );
    }
  }
  return items;
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

  const verdicts = await probeSources(req, agent.sources);
  const results = agent.sources.map(
    (source): SourceAccessResult => ({
      sourceId: source.sourceId,
      accessible: verdicts.get(source.sourceId) ?? false,
    }),
  );

  const accessibleFolderItems = await resolveAccessibleFolderItems(
    req,
    agent,
    agent.sources.filter(
      (source) =>
        source.kind === 'folder' && (verdicts.get(source.sourceId) ?? false),
    ),
  );

  const access: AgentSourceAccess = {
    accessibleSourceIds: results
      .filter((r) => r.accessible)
      .map((r) => r.sourceId),
    accessibleFolderItems,
    results,
  };

  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Simple pressure valve; entries are tiny and TTL-bounded anyway.
    cache.clear();
  }
  cache.set(key, { at: Date.now(), access });
  return access;
}

/** Test hook. */
export function clearAgentSourceAccessCache(): void {
  cache.clear();
  manifestCache.clear();
}
