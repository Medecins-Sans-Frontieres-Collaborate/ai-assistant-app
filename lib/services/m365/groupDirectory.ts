/**
 * Directory reads behind group targeting that go beyond "the signed-in
 * user's own membership" (lib/services/m365/groupMembership.ts):
 *
 *  - `fetchMemberGroupIds`: transitive group ids for `/me` OR for another
 *    user (the admin preview), with a paged `transitiveMemberOf` fallback
 *    for principals past Graph's `getMemberGroups` ceiling (2046 groups —
 *    Graph answers 400 `Directory_ResultSizeLimitExceeded`, which used to
 *    be negative-cached as a retryable failure and left the user with no
 *    groups for as long as they stayed in that many groups).
 *  - `fetchGroupNames`: display names for stored object ids — ONE
 *    `directoryObjects/getByIds` call per ≤1000 ids behind a short
 *    per-replica name cache, with the old per-id GET as the fallback for
 *    tenants that refuse the batch endpoint. Names are display-only and
 *    never an authorization input.
 *  - `lookupDirectoryUser`: object id + targeting attributes of a user by
 *    mail (User.Read.All), so the admin preview can evaluate the
 *    `attribute` and `group` layers for a person other than the caller.
 *
 * graphApi is imported lazily, exactly as groupMembership.ts does: a static
 * import would drag next-auth into every module graph that reaches the
 * sync principal paths.
 */
import { NextRequest } from 'next/server';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export const GROUP_SCOPES = ['Group.Read.All'];
export const USER_SCOPES = ['User.Read.All'];

/** Graph's documented page cap for directory collections. */
const TRANSITIVE_PAGE_SIZE = 999;
/** Bounds the paged fallback: 10 × 999 is far past any real membership. */
const TRANSITIVE_MAX_PAGES = 10;
/** `directoryObjects/getByIds` accepts at most 1000 ids per call. */
const GET_BY_IDS_CHUNK = 1000;
/** Per-id fallback cap — the pre-batch behaviour, kept small on purpose. */
const PER_ID_FALLBACK_CAP = 50;

const NAME_TTL_MS = 10 * 60 * 1000;
/** Deleted/unknown ids are remembered briefly so every editor open does not re-ask. */
const UNKNOWN_NAME_TTL_MS = 60 * 1000;
const MAX_NAME_ENTRIES = 5000;

type GraphJson = <T>(
  req: NextRequest,
  scopes: string[],
  path: string,
  init?: RequestInit,
) => Promise<T>;

async function graph(): Promise<GraphJson> {
  const { graphJson } = await import('@/lib/services/m365/graphApi');
  return graphJson as GraphJson;
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export type MemberGroupSubject =
  | { kind: 'me' }
  | { kind: 'user'; userId: string };

export interface MemberGroupsResult {
  groupIds: string[];
  /** True when `getMemberGroups` refused and the paged walk answered instead. */
  oversizeFallback: boolean;
  /** True when even the paged walk hit its page bound; ids are a prefix. */
  truncated: boolean;
}

function subjectPath(subject: MemberGroupSubject): string {
  return subject.kind === 'me'
    ? '/me'
    : `/users/${encodeURIComponent(subject.userId)}`;
}

/**
 * Graph answers `getMemberGroups` for a principal in more than 2046 groups
 * with a 400 — the only 400 that call produces for a well-formed body, so
 * the status alone identifies it. Anything that is not a typed M365Error
 * (network fault, mocked stand-in without a status) is not an oversize case.
 */
export function isOversizeMembershipError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'M365Error') return false;
  const { status } = error as Error & { status?: unknown };
  return status === 400;
}

function stringIds(values: unknown[] | undefined): string[] {
  return (values ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
}

async function pagedTransitiveGroups(
  graphJson: GraphJson,
  req: NextRequest,
  base: string,
): Promise<{ groupIds: string[]; truncated: boolean }> {
  const groupIds: string[] = [];
  let url: string | undefined =
    `${base}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=${TRANSITIVE_PAGE_SIZE}`;
  let pages = 0;
  while (url && pages < TRANSITIVE_MAX_PAGES) {
    const data: { value?: { id?: unknown }[]; '@odata.nextLink'?: string } =
      await graphJson(req, GROUP_SCOPES, url);
    for (const item of data.value ?? []) {
      if (typeof item?.id === 'string' && item.id) groupIds.push(item.id);
    }
    url = data['@odata.nextLink'];
    pages += 1;
  }
  return { groupIds, truncated: url !== undefined };
}

/**
 * Transitive group ids for the subject. Throws the typed Graph error on a
 * failure that is NOT the oversize case; callers decide the failure posture.
 */
export async function fetchMemberGroupIds(
  req: NextRequest,
  subject: MemberGroupSubject,
): Promise<MemberGroupsResult> {
  const graphJson = await graph();
  const base = subjectPath(subject);
  try {
    const data = await graphJson<{ value?: unknown[] }>(
      req,
      GROUP_SCOPES,
      `${base}/getMemberGroups`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ securityEnabledOnly: false }),
      },
    );
    return {
      groupIds: stringIds(data.value),
      oversizeFallback: false,
      truncated: false,
    };
  } catch (error) {
    if (!isOversizeMembershipError(error)) throw error;
    const paged = await pagedTransitiveGroups(graphJson, req, base);
    if (paged.truncated) {
      console.warn(
        `[group-membership] transitiveMemberOf walk truncated after ${TRANSITIVE_MAX_PAGES} pages subject=${sanitizeForLog(base)}`,
      );
    }
    return { ...paged, oversizeFallback: true };
  }
}

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

interface NameEntry {
  /** null = asked Graph, nothing came back (deleted or not a group). */
  name: string | null;
  expiresAt: number;
}

const nameCache = new Map<string, NameEntry>();

function readName(id: string): NameEntry | undefined {
  const entry = nameCache.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    nameCache.delete(id);
    return undefined;
  }
  // Re-insert so Map order is recency order (LRU eviction below).
  nameCache.delete(id);
  nameCache.set(id, entry);
  return entry;
}

function writeName(id: string, name: string | null): void {
  if (nameCache.size >= MAX_NAME_ENTRIES) {
    const oldest = nameCache.keys().next().value;
    if (oldest !== undefined) nameCache.delete(oldest);
  }
  nameCache.set(id, {
    name,
    expiresAt: Date.now() + (name === null ? UNKNOWN_NAME_TTL_MS : NAME_TTL_MS),
  });
}

interface DirectoryObject {
  id?: unknown;
  displayName?: unknown;
}

async function namesByBatch(
  graphJson: GraphJson,
  req: NextRequest,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let start = 0; start < ids.length; start += GET_BY_IDS_CHUNK) {
    const chunk = ids.slice(start, start + GET_BY_IDS_CHUNK);
    const data = await graphJson<{ value?: DirectoryObject[] }>(
      req,
      GROUP_SCOPES,
      '/directoryObjects/getByIds',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk, types: ['group'] }),
      },
    );
    for (const item of data.value ?? []) {
      if (typeof item?.id !== 'string' || !item.id) continue;
      found.set(
        item.id,
        typeof item.displayName === 'string' && item.displayName
          ? item.displayName
          : item.id,
      );
    }
  }
  return found;
}

async function namesOneByOne(
  graphJson: GraphJson,
  req: NextRequest,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const results = await Promise.allSettled(
    ids
      .slice(0, PER_ID_FALLBACK_CAP)
      .map((id) =>
        graphJson<DirectoryObject>(
          req,
          GROUP_SCOPES,
          `/groups/${encodeURIComponent(id)}?$select=id,displayName`,
        ),
      ),
  );
  const found = new Map<string, string>();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { id, displayName } = result.value;
    if (typeof id !== 'string' || !id) continue;
    found.set(
      id,
      typeof displayName === 'string' && displayName ? displayName : id,
    );
  }
  return found;
}

/**
 * Display names for group object ids, cache first. Ids Graph does not know
 * are simply absent from the result. Throws only when the batch call AND the
 * per-id fallback both failed to produce anything for an uncached id — a
 * caller that already has cached names for some ids still gets those.
 */
export async function fetchGroupNames(
  req: NextRequest,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const hit = readName(id);
    if (hit === undefined) missing.push(id);
    else if (hit.name !== null) out.set(id, hit.name);
  }
  if (missing.length === 0) return out;

  const graphJson = await graph();
  let found: Map<string, string>;
  try {
    found = await namesByBatch(graphJson, req, missing);
  } catch (error) {
    console.warn(
      `[group-directory] getByIds failed, falling back to per-id lookups: ${sanitizeForLog(
        error instanceof Error ? error.message.slice(0, 160) : 'unknown',
      )}`,
    );
    found = await namesOneByOne(graphJson, req, missing);
    if (found.size === 0 && missing.length > 0) throw error;
  }
  for (const id of missing) {
    const name = found.get(id) ?? null;
    writeName(id, name);
    if (name !== null) out.set(id, name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Users (admin preview)
// ---------------------------------------------------------------------------

export interface DirectoryUser {
  id: string;
  mail?: string;
  userPrincipalName?: string;
  department?: string;
  companyName?: string;
}

interface RawUser {
  id?: unknown;
  mail?: unknown;
  userPrincipalName?: unknown;
  department?: unknown;
  companyName?: unknown;
}

const USER_SELECT = '$select=id,mail,userPrincipalName,department,companyName';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function toDirectoryUser(raw: RawUser): DirectoryUser | null {
  const id = str(raw.id);
  if (!id) return null;
  return {
    id,
    mail: str(raw.mail),
    userPrincipalName: str(raw.userPrincipalName),
    department: str(raw.department),
    companyName: str(raw.companyName),
  };
}

/**
 * The directory record behind a mail address: `mail eq` first (what admins
 * type and what the limits principal is keyed on), then the UPN form for
 * tenants where the two differ. `null` when nobody matches; any other Graph
 * failure propagates typed so the caller can say "unavailable" rather than
 * "not evaluated".
 */
export async function lookupDirectoryUser(
  req: NextRequest,
  mail: string,
): Promise<DirectoryUser | null> {
  const graphJson = await graph();
  // OData literal: quotes doubled BEFORE URI-encoding (see /api/m365/groups).
  const literal = encodeURIComponent(mail.replace(/'/g, "''"));
  const byMail = await graphJson<{ value?: RawUser[] }>(
    req,
    USER_SCOPES,
    `/users?$filter=mail eq '${literal}'&${USER_SELECT}&$top=1`,
  );
  const first = byMail.value?.[0];
  if (first) {
    const user = toDirectoryUser(first);
    if (user) return user;
  }
  try {
    const byUpn = await graphJson<RawUser>(
      req,
      USER_SCOPES,
      `/users/${encodeURIComponent(mail)}?${USER_SELECT}`,
    );
    return toDirectoryUser(byUpn);
  } catch (error) {
    const kind = (error as { kind?: unknown } | null)?.kind;
    if (
      error instanceof Error &&
      error.name === 'M365Error' &&
      kind === 'not_found'
    ) {
      return null;
    }
    throw error;
  }
}

/** Test hook. */
export function clearGroupDirectoryCache(): void {
  nameCache.clear();
}
