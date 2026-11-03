/**
 * Skill source synchronization (docs/SKILLS_DESIGN.md §12).
 *
 * A source is an `index.json` on a public https host:
 *   { "skills": [ { "name": "<skill-id>", "version": "1.2.0", "files": ["SKILL.md", ...] } ] }
 * Files resolve to `<index directory>/<name>/<file>` on the SAME origin and
 * under the index's path; anything else is rejected, including a redirect
 * that lands elsewhere. Only SKILL.md is imported (reference documents go
 * through the indexed-upload path, not sync). A skill the source delivers
 * becomes an ordinary organization skill tagged with `source`; admin-set
 * activation / agent / consent flags on an already-synced skill survive
 * refreshes, a brand-new skill is clamped to a safe posture (never `always`,
 * never agent-enabled) until an admin says otherwise, and a skill that was
 * not created by this source is never overwritten (`conflict`).
 */
import {
  createAgentAccessBlobStorage,
  listAllSkills,
  readSkill,
  writeSkill,
  writeSkillHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import {
  SKILL_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';
import {
  fetchPublicUrl,
  isHttpsPublicShapedUrl,
  readBodyWithLimit,
} from '@/lib/utils/server/net/publicUrlGuard';

import { BUILTIN_SKILL_IDS } from './builtinSkills';
import { validateResourcePath } from './skillFiles';
import { ParsedSkillMarkdown, parseSkillMarkdown } from './skillMarkdown';
import { mutateSkillSource, readSkillSources } from './skillSourceStore';
import {
  SKILL_LIMITS,
  Skill,
  SkillIdSchema,
  SkillSource,
  SkillSourceEntryState,
  SkillSourceIndexSchema,
} from './types';

const LEASE_MS = 5 * 60 * 1000;
/** Entries processed between lease extensions on long syncs. */
const LEASE_EXTEND_EVERY = 5;
const FETCH_TIMEOUT_MS = 15_000;
/** Finalization must not depend on the (possibly aborted) loop signal. */
const FINALIZE_TIMEOUT_MS = 10_000;
const AUTO_SYNC_BUDGET_MS = 180_000;

type FetchImpl = typeof fetch;

export interface SyncOptions {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  /** Re-import entries whose version is unchanged. */
  force?: boolean;
  /** Recorded as `updatedBy` on skills and history. */
  actor?: string;
}

/** Throws unless `url` is an https URL on a public-shaped host, without credentials. */
export function validateSourceUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed.length > 2048) throw new Error('Source URL is too long');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Source URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('Source URL must use https');
  if (url.username || url.password)
    throw new Error('Source URL must not carry credentials');
  if (!isHttpsPublicShapedUrl(url.toString()))
    throw new Error('Source URL must point at a public host');
  return url;
}

/** `<index directory>/<name>/<file>`, same origin and under the index path. */
export function resolveSourceFile(
  indexUrl: URL,
  name: string,
  file: string,
): URL {
  validateResourcePath(file);
  const directory = new URL('.', indexUrl);
  const resolved = new URL(`${encodeURIComponent(name)}/${file}`, directory);
  if (
    resolved.origin !== directory.origin ||
    !resolved.pathname.startsWith(directory.pathname) ||
    resolved.pathname.includes('/../')
  )
    throw new Error(`File ${file} of ${name} escapes the source location`);
  return resolved;
}

async function fetchText(
  url: URL,
  maxBytes: number,
  options: SyncOptions,
): Promise<string> {
  const { response, resolvedUrl } = await fetchPublicUrl(url.toString(), {
    fetchImpl: options.fetchImpl,
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { accept: 'application/json, text/markdown, text/plain' },
  });
  // The guard keeps redirects public; the source contract additionally
  // keeps them on the catalog's own origin so a redirector cannot swap in
  // content from elsewhere.
  if (new URL(resolvedUrl).origin !== url.origin) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Redirected off the source origin');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const bytes = await readBodyWithLimit(response, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // FetchUrlError (publicUrlGuard) carries a stable code worth surfacing.
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
}

/** Whether a refresh would change anything the feed controls. */
function sameContent(existing: Skill, parsed: ParsedSkillMarkdown): boolean {
  return (
    existing.name === parsed.name &&
    existing.description === parsed.description &&
    existing.instructions === parsed.instructions &&
    JSON.stringify(existing.foreignFrontmatter ?? null) ===
      JSON.stringify(parsed.foreignFrontmatter ?? null)
  );
}

/**
 * Runs one sync of `sourceId`. Returns the updated source, `null` when it
 * no longer exists, or the unchanged source when another replica holds the
 * sync lease (`busy: true`).
 */
export async function syncSkillSource(
  storage: BlobStorage,
  sourceId: string,
  options: SyncOptions = {},
): Promise<{ source: SkillSource | null; busy: boolean }> {
  const now = Date.now();
  let busy = false;
  const leased = await mutateSkillSource(
    storage,
    sourceId,
    (source) => {
      if ((source.syncLeaseUntil ?? 0) > now) {
        busy = true;
        return source;
      }
      return { ...source, syncLeaseUntil: now + LEASE_MS };
    },
    options.signal,
  );
  if (!leased) return { source: null, busy: false };
  if (busy) return { source: leased, busy: true };
  const source = leased;
  const actor = options.actor ?? `source:${source.id}`;

  const entries: SkillSourceEntryState[] = [];
  let error: string | undefined;
  let processed = 0;
  const extendLease = async () => {
    processed += 1;
    if (processed % LEASE_EXTEND_EVERY) return;
    await mutateSkillSource(
      storage,
      sourceId,
      (current) => ({ ...current, syncLeaseUntil: Date.now() + LEASE_MS }),
      options.signal,
    ).catch(() => undefined);
  };
  try {
    const indexUrl = validateSourceUrl(source.url);
    const indexText = await fetchText(
      indexUrl,
      SKILL_LIMITS.sourceIndexMaxBytes,
      options,
    );
    const index = SkillSourceIndexSchema.parse(JSON.parse(indexText));
    const seen = new Set<string>();
    for (const item of index.skills.slice(0, SKILL_LIMITS.maxSourceSkills)) {
      options.signal?.throwIfAborted();
      await extendLease();
      const idCheck = SkillIdSchema.safeParse(item.name);
      if (!idCheck.success || seen.has(item.name)) {
        entries.push({
          id: item.name.slice(0, 64),
          status: 'invalid',
          detail: seen.has(item.name)
            ? 'Duplicate entry'
            : 'Name is not a valid skill id',
        });
        continue;
      }
      seen.add(item.name);
      const id = idCheck.data;
      if (BUILTIN_SKILL_IDS.has(id)) {
        entries.push({
          id,
          version: item.version,
          status: 'conflict',
          detail: 'Built-in skill ids cannot be sourced',
        });
        continue;
      }
      const existing = await readSkill(storage, id, options.signal);
      if (
        existing &&
        (!existing.skill.source || existing.skill.source.sourceId !== source.id)
      ) {
        entries.push({
          id,
          version: item.version,
          status: 'conflict',
          detail: existing.skill.source
            ? 'Owned by another source'
            : 'An admin-created skill with this id exists',
        });
        continue;
      }
      // The skill record is the source of truth for "already at this
      // version", so an interrupted sync resumes without re-fetching.
      const unchanged =
        !options.force &&
        !!item.version &&
        existing?.skill.source?.version === item.version;
      if (unchanged) {
        entries.push({ id, version: item.version, status: 'synced' });
        continue;
      }
      if (!item.files.includes('SKILL.md')) {
        entries.push({
          id,
          version: item.version,
          status: 'invalid',
          detail: 'Entry lists no SKILL.md',
        });
        continue;
      }
      try {
        const skillUrl = resolveSourceFile(indexUrl, id, 'SKILL.md');
        const markdown = await fetchText(
          skillUrl,
          SKILL_LIMITS.sourceSkillMdMaxBytes,
          options,
        );
        const parsed = parseSkillMarkdown(markdown);
        if (!parsed.ok) {
          entries.push({
            id,
            version: item.version,
            status: 'invalid',
            detail: parsed.errors.join('; ').slice(0, 300),
          });
          continue;
        }
        if (parsed.skill.id !== id) {
          entries.push({
            id,
            version: item.version,
            status: 'invalid',
            detail: `SKILL.md name "${parsed.skill.id}" differs from the catalog entry`,
          });
          continue;
        }
        const extra = item.files.filter((file) => file !== 'SKILL.md');
        const detail = extra.length
          ? {
              detail: `${extra.length} reference file(s) listed but not imported`,
            }
          : {};
        // Identical content at an unchanged (or absent) version: nothing to
        // write — no history entry, no `updatedAt` bump that would make every
        // persisted agent thread re-preload the body.
        if (
          existing &&
          sameContent(existing.skill, parsed.skill) &&
          (existing.skill.source?.version ?? undefined) ===
            (item.version ?? undefined)
        ) {
          entries.push({
            id,
            version: item.version,
            status: 'synced',
            ...detail,
          });
          continue;
        }
        const timestamp = new Date().toISOString();
        const skill: Skill = {
          version: 1,
          id,
          name: parsed.skill.name,
          description: parsed.skill.description,
          instructions: parsed.skill.instructions,
          // Admin-governed flags survive refreshes. A NEW sourced skill is
          // clamped: a feed may not put itself into every prompt (`always`)
          // or in front of agents until an admin opts in; its own
          // "ask first" request is honoured.
          activation: existing
            ? existing.skill.activation
            : parsed.skill.activation === 'always'
              ? 'auto'
              : parsed.skill.activation,
          applyToAgents: existing ? existing.skill.applyToAgents : false,
          requireConsent:
            existing?.skill.requireConsent ??
            parsed.skill.requireConsent ??
            false,
          ...(parsed.skill.foreignFrontmatter
            ? { foreignFrontmatter: parsed.skill.foreignFrontmatter }
            : {}),
          documents: existing?.skill.documents ?? [],
          source: {
            sourceId: source.id,
            ...(item.version ? { version: item.version } : {}),
            syncedAt: timestamp,
          },
          createdBy: existing?.skill.createdBy ?? actor,
          createdAt: existing?.skill.createdAt ?? timestamp,
          updatedBy: actor,
          updatedAt: timestamp,
        };
        await writeSkill(storage, skill, existing?.etag ?? null);
        await writeSkillHistoryEntry(storage, {
          version: 1,
          canonicalKey: canonicalAgentKey(SKILL_SOURCE, id),
          action: 'upsert',
          skill,
          updatedBy: actor,
          updatedAt: timestamp,
        }).catch((historyError) =>
          console.error(
            '[skills] Source sync history write failed (audit only)',
            historyError,
          ),
        );
        entries.push({
          id,
          version: item.version,
          status: 'synced',
          ...detail,
        });
      } catch (entryError) {
        entries.push({
          id,
          version: item.version,
          status:
            entryError instanceof AgentAccessConflictError
              ? 'conflict'
              : 'invalid',
          detail: describe(entryError).slice(0, 300),
        });
      }
    }
  } catch (syncError) {
    error = describe(syncError).slice(0, 500);
  }

  // Finalize on a fresh deadline: the loop's signal may already have fired
  // (route abort, auto-sync budget), and losing the outcome would leave the
  // lease held and the work repeated.
  const finished = await mutateSkillSource(
    storage,
    sourceId,
    (current) => ({
      ...current,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: error ? 'error' : 'ok',
      ...(error ? { lastError: error } : { lastError: undefined }),
      // A failed or interrupted pass keeps the previous entry list for the
      // ids it did not reach: the skills they delivered are still there.
      entries: error
        ? [
            ...entries,
            ...current.entries.filter(
              (previous) => !entries.some((entry) => entry.id === previous.id),
            ),
          ]
        : entries,
      syncLeaseUntil: undefined,
    }),
    AbortSignal.timeout(FINALIZE_TIMEOUT_MS),
  );
  return { source: finished, busy: false };
}

/**
 * Clears the `source` reference from every skill a source delivered. The
 * skills stay (an admin deleting a subscription must not lose guidance users
 * rely on); they become ordinary admin-owned skills. Scans the store rather
 * than trusting the entry list, which can miss skills the feed later dropped
 * or broke.
 */
export async function detachSkillSource(
  storage: BlobStorage,
  source: Pick<SkillSource, 'id'>,
  actor: string,
): Promise<void> {
  const owned = (await listAllSkills(storage))
    .filter((stored) => stored.record.source?.sourceId === source.id)
    .map((stored) => ({ skill: stored.record, etag: stored.etag }));
  for (const stored of owned) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing =
        attempt === 0 ? stored : await readSkill(storage, stored.skill.id);
      if (!existing || existing.skill.source?.sourceId !== source.id) break;
      const { source: _detached, ...rest } = existing.skill;
      const skill: Skill = {
        ...rest,
        updatedBy: actor,
        updatedAt: new Date().toISOString(),
      };
      try {
        await writeSkill(storage, skill, existing.etag);
        break;
      } catch (error) {
        if (!(error instanceof AgentAccessConflictError) || attempt === 2)
          throw error;
      }
    }
  }
}

/**
 * Refreshes sources whose last sync is older than the interval. Called from
 * the maintenance cadence; bounded to one source per call so a sweep never
 * turns into a crawl.
 */
export async function autoSyncSkillSources(
  storage: BlobStorage = createAgentAccessBlobStorage(),
  now = Date.now(),
): Promise<void> {
  const { document, corrupt } = await readSkillSources(storage);
  if (corrupt) return;
  const due = document.sources.find(
    (source) =>
      (source.syncLeaseUntil ?? 0) <= now &&
      (!source.lastSyncAt ||
        Date.parse(source.lastSyncAt) + SKILL_LIMITS.sourceSyncIntervalMs <=
          now),
  );
  if (!due) return;
  await syncSkillSource(storage, due.id, {
    signal: AbortSignal.timeout(AUTO_SYNC_BUDGET_MS),
  });
}
