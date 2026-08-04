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
 * Folder sources additionally get one security-trimmed children listing per
 * accessible folder, yielding the per-item trim for their chunks.
 * Verdicts are cached per user+agent for a short TTL (per-process, like the
 * access-rules snapshot): max staleness after a permission revocation in
 * SharePoint is CACHE_TTL_MS.
 */
import { NextRequest } from 'next/server';

import type {
  M365Agent,
  M365AgentSource,
} from '@/lib/services/agentAccess/types';
import { graphJson } from '@/lib/services/m365/graphApi';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const GRAPH_SCOPES = ['Files.ReadWrite.All'];
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 2000;
/** Graph JSON batching allows at most 20 sub-requests per call. */
const GRAPH_BATCH_SIZE = 20;
/** Matches the indexing-side folder expansion page (agentIndexService). */
const FOLDER_CHILD_PAGE = 200;

export interface SourceAccessResult {
  sourceId: string;
  accessible: boolean;
}

export interface AgentSourceAccess {
  /** Sources the user's own token can currently open. */
  accessibleSourceIds: string[];
  /**
   * Child FILE item ids the user can see inside accessible folder sources.
   * Folder chunks are trimmed per-item with this list — a folder-level
   * verdict alone would leak children with tighter item-level permissions
   * (broken inheritance) to anyone who can open the folder.
   */
  accessibleFolderItemIds: string[];
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
async function probeSources(
  req: NextRequest,
  sources: M365AgentSource[],
): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>();
  for (let offset = 0; offset < sources.length; offset += GRAPH_BATCH_SIZE) {
    const slice = sources.slice(offset, offset + GRAPH_BATCH_SIZE);
    const data = await graphJson<GraphBatchResponseShape>(
      req,
      GRAPH_SCOPES,
      '/$batch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: slice.map((source, index) => ({
            id: String(offset + index),
            method: 'GET',
            url: `/drives/${encodeURIComponent(source.driveId)}/items/${encodeURIComponent(source.itemId)}?$select=id`,
          })),
        }),
      },
    );
    for (const response of data.responses ?? []) {
      const index = Number(response.id);
      const source = sources[index];
      if (!source) continue;
      const status = response.status ?? 0;
      if (status !== 200 && status !== 403 && status !== 404) {
        console.warn(
          `[m365-agents] unexpected probe status ${status} for source ${sanitizeForLog(source.sourceId)}; failing closed for this source`,
        );
      }
      verdicts.set(source.sourceId, status >= 200 && status < 300);
    }
  }
  return verdicts;
}

/**
 * Resolves the child files the USER'S OWN token can see inside each
 * accessible folder source. Graph children listings are security-trimmed,
 * so an item-restricted child simply doesn't appear for a user without
 * access. A failed listing fails CLOSED for that folder only.
 */
async function resolveAccessibleFolderItems(
  req: NextRequest,
  folders: M365AgentSource[],
): Promise<string[]> {
  const itemIds: string[] = [];
  for (const folder of folders) {
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
        itemIds.push(child.id);
      }
    } catch (error) {
      console.warn(
        `[m365-agents] folder child listing failed for source ${sanitizeForLog(folder.sourceId)}; failing closed for this folder: ${sanitizeForLog(error)}`,
      );
    }
  }
  return itemIds;
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

  const accessibleFolderItemIds = await resolveAccessibleFolderItems(
    req,
    agent.sources.filter(
      (source) =>
        source.kind === 'folder' && (verdicts.get(source.sourceId) ?? false),
    ),
  );

  const access: AgentSourceAccess = {
    accessibleSourceIds: results
      .filter((r) => r.accessible)
      .map((r) => r.sourceId),
    accessibleFolderItemIds,
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
}
