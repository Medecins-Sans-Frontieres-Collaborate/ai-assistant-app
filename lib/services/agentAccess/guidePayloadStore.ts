/**
 * Immutable guide PAYLOAD blobs — the data half of the guide meta/payload
 * split.
 *
 * Layout: `system/agent-access/guide-payloads/<id>/<ref>.<json|jsonl>.gz`.
 * Every save writes a NEW blob under a fresh ref (`If-None-Match: *`) and
 * the meta record (`guides/<id>.json`, the CAS anchor) is then swapped to
 * point at it. Readers only ever follow the meta's ref, so:
 *
 * - a lost CAS race can never leave the meta pointing at another writer's
 *   payload (each writer's blob has its own name; the loser's is orphaned
 *   and pruned);
 * - payload blobs are immutable, so the per-replica cache keys on the blob
 *   name and never revalidates — only the tiny meta (already in the ≤5s
 *   snapshot) carries freshness;
 * - a reader on a stale snapshot still finds the ref it holds, because
 *   pruning keeps a grace window (PRUNE_GRACE_MS) before deleting
 *   superseded versions.
 *
 * Formats: prose kinds (style/compliance/tone/structure) are one gzipped
 * JSON object of payload fields; terminology entries are gzipped JSONL, one
 * entry per line, so a corrupt line degrades alone (soft-skip with a loud
 * log) instead of losing the whole glossary. Gzip is detected by magic
 * bytes on read — no reliance on Content-Encoding handling in the SDK.
 */
import { createAgentAccessBlobStorage } from '@/lib/services/agentAccess/accessRulesStore';
import {
  AgentAccessConflictError,
  downloadBlob,
  statusCodeOf,
} from '@/lib/services/agentAccess/blobCas';
import { getPayloadCache } from '@/lib/services/agentAccess/payloadCache';
import {
  GUIDE_PAYLOAD_REF_PATTERN,
  Guide,
  GuideGlossaryEntry,
  GuideGlossaryEntrySchema,
  GuidePayloadFields,
  GuidePayloadFieldsSchema,
  GuidePayloadFormat,
  guidePayloadBlobPath,
  guidePayloadListPrefix,
  hasExternalPayload,
} from '@/lib/services/agentAccess/types';

import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import { MAX_GUIDE_ENTRIES } from '@/lib/utils/shared/review/guideCriteria';

import { randomBytes } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';

/**
 * A superseded payload version is kept until it has been superseded for at
 * least this long, so a replica whose snapshot predates the save (≤ the 5s
 * sentinel probe, 60s TTL worst case) can still serve the ref it holds.
 * Generous on purpose: an orphan costs bytes, a missing blob costs a failed
 * request. "Superseded for" is measured from the CREATION time of the next
 * newer version — computable from names alone (refs embed their epoch).
 */
export const PRUNE_GRACE_MS = 10 * 60 * 1000;

/** Decoded-bytes ceiling for a single payload read (storage sanity). */
const MAX_DECODED_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface WrittenGuidePayload {
  payloadRef: string;
  payloadFormat: GuidePayloadFormat;
  /** terminology: entries written. Absent for prose kinds. */
  entryCount?: number;
}

/** `<base36 epoch ms>-<8 hex>` — sortable, unique, path-safe. */
export function newPayloadRef(now = Date.now()): string {
  return `${now.toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** Epoch ms encoded in a ref, or null for a malformed one. */
export function payloadRefTimestamp(ref: string): number | null {
  if (!GUIDE_PAYLOAD_REF_PATTERN.test(ref)) return null;
  const ms = parseInt(ref.slice(0, ref.indexOf('-')), 36);
  return Number.isFinite(ms) ? ms : null;
}

export function payloadFormatForKind(kind: Guide['kind']): GuidePayloadFormat {
  return kind === 'terminology' ? 'jsonl' : 'json';
}

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

function encodePayload(
  kind: Guide['kind'],
  fields: GuidePayloadFields,
): { buffer: Buffer; format: GuidePayloadFormat; entryCount?: number } {
  if (kind === 'terminology') {
    const entries = fields.entries ?? [];
    const lines = entries.map((entry) => JSON.stringify(entry));
    return {
      buffer: gzipSync(Buffer.from(lines.join('\n'), 'utf8')),
      format: 'jsonl',
      entryCount: entries.length,
    };
  }
  const { entries: _entries, ...prose } = fields;
  return {
    buffer: gzipSync(Buffer.from(JSON.stringify(prose), 'utf8')),
    format: 'json',
  };
}

function decodeBuffer(raw: Buffer, blobPath: string): Buffer {
  const decoded =
    raw.length >= 2 && raw[0] === GZIP_MAGIC_0 && raw[1] === GZIP_MAGIC_1
      ? gunzipSync(raw, { maxOutputLength: MAX_DECODED_PAYLOAD_BYTES })
      : raw;
  if (decoded.length > MAX_DECODED_PAYLOAD_BYTES) {
    throw new Error(`Guide payload blob exceeds size ceiling: ${blobPath}`);
  }
  return decoded;
}

/**
 * JSONL → entries. A line that fails to parse or validate is SKIPPED with a
 * loud log — the glossary degrades by one term instead of vanishing. The
 * count is capped defensively at the write-side maximum.
 */
export function parseGlossaryJsonl(
  text: string,
  blobPath: string,
): GuideGlossaryEntry[] {
  const entries: GuideGlossaryEntry[] = [];
  let skipped = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (entries.length >= MAX_GUIDE_ENTRIES) {
      skipped += 1;
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const parsed = GuideGlossaryEntrySchema.safeParse(json);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    entries.push(parsed.data);
  }
  if (skipped > 0) {
    console.error(
      `[agent-access] SKIPPED ${skipped} malformed/overflow glossary line(s) in ${sanitizeForLog(blobPath)} (remaining entries still serve)`,
    );
  }
  return entries;
}

function decodePayload(
  raw: Buffer,
  format: GuidePayloadFormat,
  blobPath: string,
): { fields: GuidePayloadFields; bytes: number } {
  const decoded = decodeBuffer(raw, blobPath);
  const text = decoded.toString('utf8');
  if (format === 'jsonl') {
    return {
      fields: { entries: parseGlossaryJsonl(text, blobPath) },
      bytes: decoded.length,
    };
  }
  const parsed = GuidePayloadFieldsSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `Malformed guide payload blob ${blobPath}: ${parsed.error.message}`,
    );
  }
  return { fields: parsed.data, bytes: decoded.length };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/**
 * Writes a NEW immutable payload version for `id` and returns the fields the
 * meta record must carry to reference it. Create-only (`If-None-Match: *`):
 * a ref collision (astronomically unlikely) surfaces as a conflict rather
 * than an overwrite.
 */
export async function writeGuidePayload(
  storage: BlobStorage,
  id: string,
  kind: Guide['kind'],
  fields: GuidePayloadFields,
): Promise<WrittenGuidePayload> {
  const encoded = encodePayload(kind, fields);
  const payloadRef = newPayloadRef();
  const blobPath = guidePayloadBlobPath(id, payloadRef, encoded.format);
  const client = storage.getBlockBlobClient(blobPath);
  try {
    await withAzureRetry(
      () =>
        client.upload(encoded.buffer, encoded.buffer.length, {
          blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
          conditions: { ifNoneMatch: '*' },
        }),
      { label: 'agentAccess.writeGuidePayload' },
    );
  } catch (error) {
    const status = statusCodeOf(error);
    if (status === 409 || status === 412) throw new AgentAccessConflictError();
    throw error;
  }
  return {
    payloadRef,
    payloadFormat: encoded.format,
    ...(encoded.entryCount !== undefined
      ? { entryCount: encoded.entryCount }
      : {}),
  };
}

/**
 * Reads one payload version. Null when the blob is gone (pruned or never
 * written). Goes through the shared byte-bounded cache: the blob name is
 * immutable, so a hit needs no revalidation.
 */
export async function readGuidePayload(
  storage: BlobStorage,
  id: string,
  ref: string,
  format: GuidePayloadFormat,
): Promise<GuidePayloadFields | null> {
  if (!GUIDE_PAYLOAD_REF_PATTERN.test(ref)) return null;
  const blobPath = guidePayloadBlobPath(id, ref, format);
  const entry = await getPayloadCache().getOrLoadImmutable<GuidePayloadFields>(
    blobPath,
    async () => {
      const downloaded = await downloadBlob(
        storage,
        blobPath,
        'agentAccess.readGuidePayload',
        { abortSignal: AbortSignal.timeout(20_000) },
      );
      if (downloaded === null) return null;
      // Decoded size approximates the resident footprint; the gzip ratio
      // is exactly what we don't want to be charged for.
      const { fields, bytes } = decodePayload(
        downloaded.buffer,
        format,
        blobPath,
      );
      return { value: fields, bytes };
    },
  );
  return entry?.value ?? null;
}

/**
 * Returns the guide with its payload fields inline — the only shape the
 * prompt builders and viewers consume. Legacy inline records pass through;
 * split records load their blob (cached). Null when the referenced blob is
 * missing: callers fail closed exactly as for an unknown guide.
 */
export async function hydrateGuide(
  guide: Guide,
  storage?: BlobStorage,
): Promise<Guide | null> {
  if (!hasExternalPayload(guide)) return guide;
  const ref = guide.payloadRef;
  const format = guide.payloadFormat ?? payloadFormatForKind(guide.kind);
  if (!ref) return guide;
  // Storage is only instantiated when a blob actually has to be read, so
  // legacy inline records (and tests built on them) never touch it.
  const fields = await readGuidePayload(
    storage ?? createAgentAccessBlobStorage(),
    guide.id,
    ref,
    format,
  );
  if (fields === null) return null;
  return { ...guide, ...fields };
}

/**
 * Deletes superseded payload versions of `id`. A version is prunable when
 * it is not `keepRef` and the version that superseded it (the next newer
 * ref) is itself older than the grace window — i.e. every snapshot that
 * could still name it has long since refreshed. `keepRef: null` prunes ALL
 * versions regardless of age (the guide itself is gone). Best-effort by
 * contract — callers log and move on; an orphan is only wasted bytes, and
 * the next successful save prunes again.
 */
export async function pruneGuidePayloads(
  storage: BlobStorage,
  id: string,
  keepRef: string | null,
  now = Date.now(),
): Promise<number> {
  const prefix = guidePayloadListPrefix(id);
  const names = await storage.listBlobs(prefix);
  const versions = names
    .map((name) => {
      const file = name.slice(prefix.length);
      const ref = file.slice(0, file.indexOf('.'));
      return { name, ref, ts: payloadRefTimestamp(ref) };
    })
    // Unparseable names are foreign — leave them for a human.
    .filter(
      (v): v is { name: string; ref: string; ts: number } => v.ts !== null,
    )
    .sort((a, b) => a.ts - b.ts);
  const candidates = versions.filter((version, index) => {
    if (keepRef === null) return true;
    if (version.ref === keepRef) return false;
    // Newer versions strictly above this one; the earliest of them is the
    // moment this version stopped being the live one.
    const successor = versions
      .slice(index + 1)
      .find((v) => v.ts > version.ts || v.ref === keepRef);
    const supersededAt = successor ? successor.ts : now;
    return now - supersededAt >= PRUNE_GRACE_MS;
  });
  let deleted = 0;
  for (const { name } of candidates) {
    try {
      await withAzureRetry(() => storage.getBlockBlobClient(name).delete(), {
        label: 'agentAccess.pruneGuidePayload',
      });
      getPayloadCache().delete(name);
      deleted += 1;
    } catch (error) {
      if (statusCodeOf(error) === 404) continue;
      console.error(
        `[agent-access] guide payload prune failed for ${sanitizeForLog(name)} (orphan remains; the next save retries): ${sanitizeForLog(error)}`,
      );
    }
  }
  return deleted;
}

/** Best-effort removal of a single just-written version (CAS loser). */
export async function discardGuidePayload(
  storage: BlobStorage,
  id: string,
  written: WrittenGuidePayload,
): Promise<void> {
  const blobPath = guidePayloadBlobPath(
    id,
    written.payloadRef,
    written.payloadFormat,
  );
  try {
    await withAzureRetry(() => storage.getBlockBlobClient(blobPath).delete(), {
      label: 'agentAccess.discardGuidePayload',
    });
  } catch (error) {
    if (statusCodeOf(error) === 404) return;
    console.error(
      `[agent-access] orphaned guide payload ${sanitizeForLog(blobPath)} could not be removed (pruned on the next save): ${sanitizeForLog(error)}`,
    );
  }
  getPayloadCache().delete(blobPath);
}
