/**
 * Plan phase for M365 file-backed agents
 * (docs/M365_SEVENTH_PASS_RECURSIVE_AGENT_SOURCES.md §1–§3).
 *
 * Turns an agent's sources into a per-file manifest WITHOUT downloading
 * anything: folders are enumerated with Graph `/delta` (the whole subtree
 * as one flat paged stream, plus a delta link for incremental refresh) or
 * `/children` (non-recursive, or as a fallback when delta is refused), and
 * every file is classified from metadata alone — indexable now, needs a
 * per-file preparation step, or skipped with a reason. Cap accounting
 * counts only what will actually be indexed, so the admin learns that a
 * folder is too big, or full of videos, before a single byte moves.
 *
 * Everything Graph-facing runs with the CALLING ADMIN'S delegated token;
 * the pure parts (classification, filters, counts) are exported for tests
 * and reused by the index run so plan and ingestion can never disagree.
 */
import { NextRequest } from 'next/server';

import type {
  M365ManifestFolder,
  M365ManifestItem,
  M365ManifestSkipReason,
  M365ManifestTier,
  M365SourceCounts,
} from '@/lib/services/agentAccess/types';
import { INDEXABLE_EXTENSIONS } from '@/lib/services/m365/documentSignature';
import { M365Error, graphJson } from '@/lib/services/m365/graphApi';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';
import {
  DISALLOWED_EXTENSIONS_NO_DOT,
  DISALLOWED_MIME_TYPES,
} from '@/lib/constants/disallowedFileTypes';
import { getFileCategory } from '@/lib/constants/fileLimits';

const GRAPH_SCOPES = ['Files.ReadWrite.All'];

/** Documents per agent after expansion (env-tunable, default 50). */
export const MAX_M365_AGENT_DOCUMENTS = env.M365_AGENT_MAX_DOCUMENTS;
/** Sum of indexable file sizes per agent (env-tunable, default 512 MB). */
export const MAX_M365_AGENT_SOURCE_BYTES =
  env.M365_AGENT_MAX_SOURCE_MB * 1024 * 1024;
/** Per-file byte cap — matches the extraction budget, with headroom. */
export const MAX_M365_SOURCE_FILE_BYTES = 25 * 1024 * 1024;
/**
 * Items (files + folders) the planner will enumerate under one source
 * before giving up. Bounds Graph spend on a 40 000-item library; the admin
 * is told to pick a subfolder instead.
 */
export const ENUMERATION_CEILING = 1000;
/** Graph page size for children/delta listings. */
const PAGE_SIZE = 200;
/** BFS fallback depth guard (delta has no such limit). */
const MAX_FOLDER_DEPTH = 20;
/** Enumeration results are reused between Add, Save and Index. */
const ENUMERATION_CACHE_TTL_MS = 2 * 60_000;
const ENUMERATION_CACHE_MAX = 500;

const GRAPH_SELECT =
  '$select=id,name,size,file,folder,parentReference,webUrl,lastModifiedDateTime,eTag,malware,deleted';

export interface PlanSourceInput {
  sourceId?: string;
  driveId: string;
  itemId: string;
  kind: 'file' | 'folder';
  recursive?: boolean;
  excludedItemIds?: string[];
  includeExtensions?: string[];
}

export interface SourcePlan {
  /** The source item itself could not be read (404/403 with the admin's token). */
  missing: boolean;
  /** Enumeration stopped at ENUMERATION_CEILING — the listing is incomplete. */
  truncated: boolean;
  deltaLink?: string;
  folders: M365ManifestFolder[];
  items: M365ManifestItem[];
  counts: M365SourceCounts;
}

export interface AgentPlan {
  plans: SourcePlan[];
  totalDocuments: number;
  totalBytes: number;
  maxDocuments: number;
  maxBytes: number;
  overDocumentCap: boolean;
  overByteCap: boolean;
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

export interface ClassifiableItem {
  name: string;
  size?: number;
  mimeType?: string;
  /** Graph `malware` facet present → Microsoft flagged the item. */
  malware?: boolean;
}

export interface Classification {
  tier: M365ManifestTier;
  reason?: M365ManifestSkipReason;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** Image formats a vision model can be handed (svg is markup, not pixels). */
const PREPARABLE_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'heic',
]);

/**
 * Metadata-only tiering (§3). Order matters: Microsoft's malware verdict
 * and the executable/archive denylist win over everything; then the
 * indexable set; then media that a per-file preparation step could turn
 * into text; everything else is skipped as unsupported.
 */
export function classifyItem(item: ClassifiableItem): Classification {
  const ext = extensionOf(item.name);
  const size = item.size ?? 0;
  const mime = item.mimeType?.toLowerCase();

  if (item.malware) return { tier: 'skipped', reason: 'malware' };
  if (DISALLOWED_EXTENSIONS_NO_DOT.includes(ext)) {
    return { tier: 'skipped', reason: 'disallowedType' };
  }
  // Graph reports octet-stream for anything it can't type; that alone is
  // not evidence of an executable — the extension decides below.
  if (
    mime &&
    mime !== 'application/octet-stream' &&
    DISALLOWED_MIME_TYPES.includes(mime)
  ) {
    return { tier: 'skipped', reason: 'disallowedType' };
  }

  if (INDEXABLE_EXTENSIONS.has(ext)) {
    if (size <= 0) return { tier: 'skipped', reason: 'zeroBytes' };
    if (size > MAX_M365_SOURCE_FILE_BYTES) {
      return { tier: 'skipped', reason: 'tooLarge' };
    }
    return { tier: 'indexable' };
  }

  const category = getFileCategory(item.name, item.mimeType);
  const preparable =
    (category === 'image' && PREPARABLE_IMAGE_EXTENSIONS.has(ext)) ||
    category === 'audio' ||
    category === 'video';
  if (preparable) {
    if (size <= 0) return { tier: 'skipped', reason: 'zeroBytes' };
    return { tier: 'needsPreparation' };
  }
  return { tier: 'skipped', reason: 'unsupported' };
}

/**
 * Applies the admin's exclusions and extension filter to a classified
 * listing. Excluding a folder excludes its whole subtree. Returns new item
 * objects; the enumeration itself is untouched so cached listings can be
 * re-filtered cheaply.
 */
export function applySourceFilters(
  items: M365ManifestItem[],
  folders: M365ManifestFolder[],
  input: Pick<PlanSourceInput, 'excludedItemIds' | 'includeExtensions'>,
): M365ManifestItem[] {
  const excluded = new Set(input.excludedItemIds ?? []);
  if (excluded.size > 0) {
    const parentOf = new Map(folders.map((f) => [f.itemId, f.parentItemId]));
    for (const folder of folders) {
      let cursor: string | undefined = folder.itemId;
      let hops = 0;
      while (cursor && hops < MAX_FOLDER_DEPTH + 1) {
        if (excluded.has(cursor)) {
          excluded.add(folder.itemId);
          break;
        }
        cursor = parentOf.get(cursor);
        hops += 1;
      }
    }
  }
  const allowedExtensions = input.includeExtensions?.length
    ? new Set(input.includeExtensions.map((e) => e.toLowerCase()))
    : null;

  return items.map((item) => {
    if (excluded.has(item.itemId) || excluded.has(item.parentItemId)) {
      return { ...item, tier: 'skipped', reason: 'excluded' };
    }
    if (
      allowedExtensions &&
      item.tier !== 'skipped' &&
      !allowedExtensions.has(extensionOf(item.name))
    ) {
      return { ...item, tier: 'skipped', reason: 'typeFilter' };
    }
    return item;
  });
}

export function summarizeCounts(items: M365ManifestItem[]): M365SourceCounts {
  const counts: M365SourceCounts = {
    indexable: 0,
    needsPreparation: 0,
    skipped: 0,
    bytes: 0,
  };
  for (const item of items) {
    if (item.tier === 'indexable') {
      counts.indexable += 1;
      counts.bytes += item.size;
    } else if (item.tier === 'needsPreparation') {
      counts.needsPreparation += 1;
    } else {
      counts.skipped += 1;
    }
    if (item.status === 'indexed') counts.indexed = (counts.indexed ?? 0) + 1;
    else if (item.status === 'failed') counts.failed = (counts.failed ?? 0) + 1;
    else if (item.status === 'noText') counts.noText = (counts.noText ?? 0) + 1;
    else if (item.status === 'missing')
      counts.missing = (counts.missing ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Enumeration (Graph, admin token)
// ---------------------------------------------------------------------------

interface GraphItem {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  eTag?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  malware?: { description?: string } | null;
  deleted?: unknown;
  parentReference?: { id?: string; driveId?: string };
}

interface GraphPage {
  value?: GraphItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface RawEnumeration {
  missing: boolean;
  truncated: boolean;
  deltaLink?: string;
  folders: M365ManifestFolder[];
  /** Classified but unfiltered. */
  items: M365ManifestItem[];
}

interface CacheEntry {
  at: number;
  value: RawEnumeration;
}

const enumerationCache = new Map<string, CacheEntry>();

function cacheKey(userId: string, input: PlanSourceInput): string {
  return `${userId}:${input.driveId}:${input.itemId}:${input.kind}:${input.recursive ? 1 : 0}`;
}

/** Test hook. */
export function clearPlannerCacheForTests(): void {
  enumerationCache.clear();
}

function itemPath(encoded: string): string {
  return encodeURIComponent(encoded);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof M365Error &&
    (error.kind === 'not_found' || error.kind === 'forbidden')
  );
}

/**
 * Collects a paged listing (children or delta) into files + folders until
 * the ceiling. Delta streams include the root folder itself and tombstones;
 * both are dropped.
 */
async function collectPages(
  req: NextRequest,
  firstUrl: string,
  rootItemId: string,
  sink: { files: GraphItem[]; folders: GraphItem[] },
): Promise<{ truncated: boolean; deltaLink?: string }> {
  let url: string | undefined = firstUrl;
  let deltaLink: string | undefined;
  while (url) {
    const page: GraphPage = await graphJson<GraphPage>(req, GRAPH_SCOPES, url);
    for (const item of page.value ?? []) {
      if (!item.id || !item.name || item.deleted) continue;
      if (item.id === rootItemId) continue;
      if (item.folder) sink.folders.push(item);
      else sink.files.push(item);
      if (sink.files.length + sink.folders.length >= ENUMERATION_CEILING) {
        return { truncated: true };
      }
    }
    deltaLink = page['@odata.deltaLink'] ?? deltaLink;
    url = page['@odata.nextLink'];
  }
  return { truncated: false, deltaLink };
}

/**
 * Recursive fallback when delta is refused (some drive types / consumer
 * accounts): breadth-first `/children`, ceiling-bounded, depth-guarded.
 */
async function collectChildrenRecursively(
  req: NextRequest,
  driveId: string,
  rootItemId: string,
  sink: { files: GraphItem[]; folders: GraphItem[] },
): Promise<{ truncated: boolean }> {
  const queue: { itemId: string; depth: number }[] = [
    { itemId: rootItemId, depth: 0 },
  ];
  while (queue.length > 0) {
    const { itemId, depth } = queue.shift()!;
    const before = sink.folders.length;
    const result = await collectPages(
      req,
      `/drives/${itemPath(driveId)}/items/${itemPath(itemId)}/children?${GRAPH_SELECT}&$top=${PAGE_SIZE}`,
      rootItemId,
      sink,
    );
    if (result.truncated) return { truncated: true };
    if (depth + 1 > MAX_FOLDER_DEPTH) continue;
    for (const folder of sink.folders.slice(before)) {
      if (folder.id) queue.push({ itemId: folder.id, depth: depth + 1 });
    }
  }
  return { truncated: false };
}

function toManifestItem(
  item: GraphItem,
  driveId: string,
  paths: Map<string, string>,
): M365ManifestItem {
  const parentItemId = item.parentReference?.id ?? '';
  const classification = classifyItem({
    name: item.name ?? '',
    size: item.size,
    mimeType: item.file?.mimeType,
    malware: !!item.malware,
  });
  return {
    itemId: item.id ?? '',
    driveId: item.parentReference?.driveId ?? driveId,
    name: item.name ?? '',
    path: paths.get(parentItemId) ?? '',
    parentItemId,
    size: item.size ?? 0,
    ...(item.file?.mimeType && { mimeType: item.file.mimeType }),
    ...(item.eTag && { eTag: item.eTag }),
    webUrl: item.webUrl ?? '',
    ...(item.lastModifiedDateTime && {
      lastModified: item.lastModifiedDateTime,
    }),
    tier: classification.tier,
    ...(classification.reason && { reason: classification.reason }),
  };
}

/**
 * Relative folder paths from parent chains. The source folder is '' and
 * anything whose chain doesn't reach it (shouldn't happen) is rooted at
 * its own name.
 */
function buildFolderPaths(
  rootItemId: string,
  folders: GraphItem[],
): { paths: Map<string, string>; nodes: M365ManifestFolder[] } {
  const byId = new Map(folders.map((f) => [f.id ?? '', f]));
  const paths = new Map<string, string>([[rootItemId, '']]);
  const resolve = (id: string, hops = 0): string => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const folder = byId.get(id);
    if (!folder || hops > MAX_FOLDER_DEPTH) return '';
    const parentId = folder.parentReference?.id ?? '';
    const parentPath = parentId ? resolve(parentId, hops + 1) : '';
    const path = parentPath
      ? `${parentPath}/${folder.name}`
      : (folder.name ?? '');
    paths.set(id, path);
    return path;
  };
  const nodes = folders
    .filter((f): f is GraphItem & { id: string } => !!f.id)
    .map((f) => ({
      itemId: f.id,
      name: f.name ?? '',
      path: resolve(f.id),
      parentItemId: f.parentReference?.id ?? '',
    }));
  return { paths, nodes };
}

async function enumerateSource(
  req: NextRequest,
  userId: string,
  input: PlanSourceInput,
): Promise<RawEnumeration> {
  const key = cacheKey(userId, input);
  const cached = enumerationCache.get(key);
  if (cached && Date.now() - cached.at < ENUMERATION_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await enumerateUncached(req, input);

  if (enumerationCache.size >= ENUMERATION_CACHE_MAX) enumerationCache.clear();
  enumerationCache.set(key, { at: Date.now(), value });
  return value;
}

async function enumerateUncached(
  req: NextRequest,
  input: PlanSourceInput,
): Promise<RawEnumeration> {
  const base = `/drives/${itemPath(input.driveId)}/items/${itemPath(input.itemId)}`;
  const empty: RawEnumeration = {
    missing: false,
    truncated: false,
    folders: [],
    items: [],
  };

  if (input.kind === 'file') {
    let item: GraphItem;
    try {
      item = await graphJson<GraphItem>(
        req,
        GRAPH_SCOPES,
        `${base}?${GRAPH_SELECT}`,
      );
    } catch (error) {
      if (isMissing(error)) return { ...empty, missing: true };
      throw error;
    }
    if (item.folder) {
      // Stored as a file but is a folder now (moved/replaced): treat as
      // missing rather than silently expanding.
      return { ...empty, missing: true };
    }
    const paths = new Map<string, string>([
      [item.parentReference?.id ?? '', ''],
    ]);
    return { ...empty, items: [toManifestItem(item, input.driveId, paths)] };
  }

  const sink = { files: [] as GraphItem[], folders: [] as GraphItem[] };
  let truncated = false;
  let deltaLink: string | undefined;
  try {
    if (input.recursive) {
      try {
        const result = await collectPages(
          req,
          `${base}/delta?${GRAPH_SELECT}&$top=${PAGE_SIZE}`,
          input.itemId,
          sink,
        );
        truncated = result.truncated;
        deltaLink = result.deltaLink;
      } catch (error) {
        if (isMissing(error)) return { ...empty, missing: true };
        if (
          error instanceof M365Error &&
          error.kind !== 'not_connected' &&
          error.kind !== 'consent_missing' &&
          error.kind !== 'rate_limited'
        ) {
          console.warn(
            `[m365-agents] delta enumeration refused for ${sanitizeForLog(input.itemId)}; falling back to recursive children listing: ${sanitizeForLog(error)}`,
          );
          sink.files.length = 0;
          sink.folders.length = 0;
          truncated = (
            await collectChildrenRecursively(
              req,
              input.driveId,
              input.itemId,
              sink,
            )
          ).truncated;
        } else {
          throw error;
        }
      }
    } else {
      truncated = (
        await collectPages(
          req,
          `${base}/children?${GRAPH_SELECT}&$top=${PAGE_SIZE}`,
          input.itemId,
          sink,
        )
      ).truncated;
      // Non-recursive: subfolders are listed for the tree but their
      // contents are not enumerated.
    }
  } catch (error) {
    if (isMissing(error)) return { ...empty, missing: true };
    throw error;
  }

  const { paths, nodes } = buildFolderPaths(input.itemId, sink.folders);
  const items = sink.files.map((file) =>
    toManifestItem(file, input.driveId, paths),
  );
  return {
    missing: false,
    truncated,
    ...(deltaLink && { deltaLink }),
    folders: nodes,
    items,
  };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function planSource(
  req: NextRequest,
  userId: string,
  input: PlanSourceInput,
): Promise<SourcePlan> {
  const raw = await enumerateSource(req, userId, input);
  const items = applySourceFilters(raw.items, raw.folders, input);
  return {
    missing: raw.missing,
    truncated: raw.truncated,
    ...(raw.deltaLink && { deltaLink: raw.deltaLink }),
    folders: raw.folders,
    items,
    counts: summarizeCounts(items),
  };
}

/** Cap accounting across sources (§2) — the same numbers the editor shows. */
export function summarizePlans(plans: SourcePlan[]): Omit<AgentPlan, 'plans'> {
  const totalDocuments = plans.reduce((n, p) => n + p.counts.indexable, 0);
  const totalBytes = plans.reduce((n, p) => n + p.counts.bytes, 0);
  return {
    totalDocuments,
    totalBytes,
    maxDocuments: MAX_M365_AGENT_DOCUMENTS,
    maxBytes: MAX_M365_AGENT_SOURCE_BYTES,
    overDocumentCap: totalDocuments > MAX_M365_AGENT_DOCUMENTS,
    overByteCap: totalBytes > MAX_M365_AGENT_SOURCE_BYTES,
  };
}

/**
 * Plans every source sequentially (each source is itself a handful of
 * metadata pages; parallelism here would only race Graph throttling).
 */
export async function planSources(
  req: NextRequest,
  userId: string,
  inputs: PlanSourceInput[],
): Promise<AgentPlan> {
  const plans: SourcePlan[] = [];
  for (const input of inputs) {
    plans.push(await planSource(req, userId, input));
  }
  return { plans, ...summarizePlans(plans) };
}
