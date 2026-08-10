/**
 * Generic blob-backed entity store for the UNIFORM agent-access entities:
 * prompt agents, MCP connectors, guides, M365 agents, and org RAG agents.
 * Each entity is one JSON blob at an id-derived path plus immutable history
 * entries, mutated exclusively through the compare-and-swap primitives in
 * ./blobCas.
 *
 * This factory exists because the per-entity blocks in accessRulesStore.ts
 * were byte-for-byte copies of each other — six of them by the time org
 * agents landed — and copy-drift in a security-adjacent store is exactly
 * the failure mode a shared implementation removes. accessRulesStore keeps
 * its public per-entity function names as thin wrappers, so callers and
 * tests are untouched.
 *
 * Semantics (identical for every entity built here):
 *
 * - `listAll` is DELIBERATELY SOFT-SKIP: a malformed blob (bad JSON, schema
 *   failure, or a blob whose name does not match its content's id-derived
 *   path — i.e. hand-placed) is SKIPPED with a loud console.error instead
 *   of failing the whole listing. A dropped record fails SAFE — it simply
 *   disappears from discovery/resolution — whereas failing the listing
 *   would couple one corrupt blob to the rules snapshot that refresh()
 *   loads alongside it and, on cold start, brick every Foundry invocation.
 *   Storage-level errors (list/download failures) still throw; a 404
 *   (deleted between list and get) stays a silent skip.
 *
 *   The RULES listing is the one place this trade-off inverts (a silently
 *   dropped restricted rule would fail OPEN), which is why rules — with
 *   their content-hash-derived paths — stay bespoke in accessRulesStore
 *   and are NOT built from this factory. Map datasets keep their split
 *   meta/data blobs there too.
 *
 * - `write` derives the blob path from the record's own id, so a record
 *   can never land at another id's path. `ifMatchEtag` set → update
 *   (`If-Match`); null → creation only (`If-None-Match: *`); 412 →
 *   {@link AgentAccessConflictError}.
 *
 * - `remove` is a conditional delete (`If-Match`); false when already
 *   absent (idempotent); 412 → {@link AgentAccessConflictError}.
 *
 * - `writeHistory` appends an immutable audit entry (`If-None-Match: *`)
 *   at `historyBlobPath(canonicalKey, updatedAt)` — same namespace as rule
 *   history. A 412 means an earlier attempt (or a retry) already landed
 *   this exact entry — idempotent success. Callers wrap best-effort: a
 *   history failure must never fail the mutation.
 */
import {
  AgentAccessConflictError,
  downloadBlob,
  statusCodeOf,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  canonicalAgentKey,
  historyBlobPath,
} from '@/lib/services/agentAccess/types';

import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { z } from 'zod';

export interface StoredEntity<T> {
  /** `<source>::<id>` — flows through delegation and rules unchanged. */
  canonicalKey: string;
  blobPath: string;
  record: T;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

export interface EntityReadResult<T> {
  record: T;
  etag: string;
}

export interface BlobEntityDefinition<
  T extends { id: string },
  H extends { canonicalKey: string; updatedAt: string },
> {
  /** Kebab noun used in log lines (e.g. 'prompt-agent'). */
  logNoun: string;
  /** Human noun used in thrown error messages (e.g. 'prompt agent'). */
  errorNoun: string;
  /** Pseudo-source half of the canonical key (e.g. PROMPT_AGENT_SOURCE). */
  source: string;
  /** Listing prefix (e.g. AGENT_ACCESS_PROMPT_AGENTS_PREFIX). */
  listPrefix: string;
  /** Id-derived blob path (must live OUTSIDE the rules/ prefix). */
  blobPath: (id: string) => string;
  schema: z.ZodType<T>;
  historySchema: z.ZodType<H>;
  /**
   * PascalCase label stem reproducing the historical withAzureRetry labels
   * (`agentAccess.write<X>` / `agentAccess.delete<X>` /
   * `agentAccess.write<X>HistoryEntry`), e.g. 'PromptAgent'.
   */
  labelBase: string;
}

export interface BlobEntityStore<
  T extends { id: string },
  H extends { canonicalKey: string; updatedAt: string },
> {
  listAll(storage: BlobStorage): Promise<StoredEntity<T>[]>;
  read(storage: BlobStorage, id: string): Promise<EntityReadResult<T> | null>;
  write(
    storage: BlobStorage,
    record: T,
    ifMatchEtag: string | null,
  ): Promise<string>;
  remove(
    storage: BlobStorage,
    id: string,
    ifMatchEtag: string,
  ): Promise<boolean>;
  writeHistory(storage: BlobStorage, entry: H): Promise<void>;
}

export function defineBlobEntity<
  T extends { id: string },
  H extends { canonicalKey: string; updatedAt: string },
>(def: BlobEntityDefinition<T, H>): BlobEntityStore<T, H> {
  async function listAll(storage: BlobStorage): Promise<StoredEntity<T>[]> {
    const names = await storage.listBlobs(def.listPrefix);
    const results = await Promise.all(
      names.map(async (name): Promise<StoredEntity<T> | null> => {
        // 404 → deleted between list and get; skip silently.
        const downloaded = await downloadBlob(storage, name);
        if (downloaded === null) return null;

        let json: unknown;
        try {
          json = JSON.parse(downloaded.buffer.toString('utf8'));
        } catch {
          console.error(
            `[agent-access] SKIPPING ${def.logNoun} blob with invalid JSON (broken ${def.logNoun} degrades alone; rules snapshot unaffected): ${sanitizeForLog(name)}`,
          );
          return null;
        }
        const parsed = def.schema.safeParse(json);
        if (!parsed.success) {
          console.error(
            `[agent-access] SKIPPING malformed ${def.logNoun} blob (broken ${def.logNoun} degrades alone; rules snapshot unaffected) ${sanitizeForLog(name)}: ${sanitizeForLog(parsed.error.message)}`,
          );
          return null;
        }
        if (def.blobPath(parsed.data.id) !== name) {
          // A stray blob must not shadow (or masquerade as) another id's
          // record.
          console.error(
            `[agent-access] SKIPPING ${def.logNoun} blob whose name does not match its content's id (broken ${def.logNoun} degrades alone; rules snapshot unaffected): ${sanitizeForLog(name)}`,
          );
          return null;
        }
        return {
          canonicalKey: canonicalAgentKey(def.source, parsed.data.id),
          blobPath: name,
          record: parsed.data,
          etag: downloaded.etag,
        };
      }),
    );
    return results.filter((r): r is StoredEntity<T> => r !== null);
  }

  async function read(
    storage: BlobStorage,
    id: string,
  ): Promise<EntityReadResult<T> | null> {
    const result = await downloadBlob(storage, def.blobPath(id));
    if (result === null) return null;
    const parsed = def.schema.safeParse(
      JSON.parse(result.buffer.toString('utf8')),
    );
    if (!parsed.success) {
      throw new Error(
        `Malformed ${def.errorNoun} blob for id ${id}: ${parsed.error.message}`,
      );
    }
    return { record: parsed.data, etag: result.etag };
  }

  async function write(
    storage: BlobStorage,
    record: T,
    ifMatchEtag: string | null,
  ): Promise<string> {
    const parsed = def.schema.parse(record);
    return uploadJson(
      storage,
      def.blobPath(parsed.id),
      parsed,
      ifMatchEtag,
      `agentAccess.write${def.labelBase}`,
    );
  }

  async function remove(
    storage: BlobStorage,
    id: string,
    ifMatchEtag: string,
  ): Promise<boolean> {
    const client = storage.getBlockBlobClient(def.blobPath(id));
    try {
      await withAzureRetry(
        () => client.delete({ conditions: { ifMatch: ifMatchEtag } }),
        { label: `agentAccess.delete${def.labelBase}` },
      );
      return true;
    } catch (error) {
      const status = statusCodeOf(error);
      if (status === 404) return false;
      if (status === 412) throw new AgentAccessConflictError();
      throw error;
    }
  }

  async function writeHistory(storage: BlobStorage, entry: H): Promise<void> {
    const parsed = def.historySchema.parse(entry);
    const client = storage.getBlockBlobClient(
      historyBlobPath(parsed.canonicalKey, parsed.updatedAt),
    );
    const content = Buffer.from(JSON.stringify(parsed), 'utf8');
    try {
      await withAzureRetry(
        () =>
          client.upload(content, content.length, {
            blobHTTPHeaders: { blobContentType: 'application/json' },
            conditions: { ifNoneMatch: '*' },
          }),
        { label: `agentAccess.write${def.labelBase}HistoryEntry` },
      );
    } catch (error) {
      if (statusCodeOf(error) === 412) return;
      throw error;
    }
  }

  return { listAll, read, write, remove, writeHistory };
}
