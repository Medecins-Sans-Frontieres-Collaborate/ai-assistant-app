/**
 * Blob store for prepared ("derived") text of M365 agent files — phase 4
 * of docs/M365_SEVENTH_PASS_RECURSIVE_AGENT_SOURCES.md.
 *
 * Files the extractors can't read (images, audio, video, scanned PDFs)
 * are turned into text by an explicit per-file preparation step. The text
 * is cached here keyed by the item's Graph eTag, so a re-index never
 * re-pays for it and a changed file (new eTag) simply drops back to
 * "needs preparation". Two blob shapes per agent:
 *
 *   m365-agent-derived/<agentId>/index.json   one small record the planner
 *                                             reads (eTag per prepared item
 *                                             + pending chunked jobs), CAS
 *   m365-agent-derived/<agentId>/<itemId>.json the text itself
 */
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  AGENT_ACCESS_M365_DERIVED_PREFIX,
  M365DerivedIndex,
  M365DerivedIndexSchema,
  M365DerivedText,
  M365DerivedTextSchema,
  m365AgentDerivedIndexBlobPath,
  m365AgentDerivedTextBlobPath,
} from '@/lib/services/agentAccess/types';

import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const CAS_RETRIES = 4;

function emptyIndex(agentId: string): M365DerivedIndex {
  return {
    version: 1,
    agentId,
    updatedAt: new Date(0).toISOString(),
    items: {},
    pending: {},
  };
}

export async function readDerivedIndex(
  storage: BlobStorage,
  agentId: string,
): Promise<{ index: M365DerivedIndex; etag: string | null }> {
  const result = await downloadBlob(
    storage,
    m365AgentDerivedIndexBlobPath(agentId),
    'agentAccess.readM365DerivedIndex',
  );
  if (result === null) return { index: emptyIndex(agentId), etag: null };
  const parsed = M365DerivedIndexSchema.safeParse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  if (!parsed.success) {
    console.error(
      `[m365-agents] ignoring malformed derived index for ${sanitizeForLog(agentId)}: ${sanitizeForLog(parsed.error.message)}`,
    );
    return { index: emptyIndex(agentId), etag: result.etag };
  }
  return { index: parsed.data, etag: result.etag };
}

/** Read-modify-write with bounded CAS retries (creates on first write). */
export async function mutateDerivedIndex(
  storage: BlobStorage,
  agentId: string,
  mutate: (index: M365DerivedIndex) => M365DerivedIndex,
): Promise<M365DerivedIndex> {
  for (let attempt = 0; attempt <= CAS_RETRIES; attempt++) {
    const { index, etag } = await readDerivedIndex(storage, agentId);
    const next = M365DerivedIndexSchema.parse({
      ...mutate(index),
      updatedAt: new Date().toISOString(),
    });
    try {
      await uploadJson(
        storage,
        m365AgentDerivedIndexBlobPath(agentId),
        next,
        etag,
        'agentAccess.writeM365DerivedIndex',
      );
      return next;
    } catch (error) {
      if (!(error instanceof AgentAccessConflictError)) throw error;
    }
  }
  throw new AgentAccessConflictError(
    'Derived index was modified concurrently too many times',
  );
}

export async function readDerivedText(
  storage: BlobStorage,
  agentId: string,
  itemId: string,
): Promise<M365DerivedText | null> {
  const result = await downloadBlob(
    storage,
    m365AgentDerivedTextBlobPath(agentId, itemId),
    'agentAccess.readM365DerivedText',
  );
  if (result === null) return null;
  const parsed = M365DerivedTextSchema.safeParse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  if (!parsed.success) {
    console.error(
      `[m365-agents] ignoring malformed derived text for ${sanitizeForLog(agentId)}/${sanitizeForLog(itemId)}: ${sanitizeForLog(parsed.error.message)}`,
    );
    return null;
  }
  return parsed.data;
}

/**
 * Stores the text, then records it in the index (in that order, so an
 * index entry never points at a missing blob). Last writer wins on the
 * text blob — the eTag in the index says which version is current.
 */
export async function writeDerivedText(
  storage: BlobStorage,
  derived: M365DerivedText,
  name: string,
): Promise<M365DerivedIndex> {
  const parsed = M365DerivedTextSchema.parse(derived);
  const client = storage.getBlockBlobClient(
    m365AgentDerivedTextBlobPath(parsed.agentId, parsed.itemId),
  );
  const content = Buffer.from(JSON.stringify(parsed), 'utf8');
  await withAzureRetry(
    () =>
      client.upload(content, content.length, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
      }),
    { label: 'agentAccess.writeM365DerivedText' },
  );
  return mutateDerivedIndex(storage, parsed.agentId, (index) => {
    const { [parsed.itemId]: _done, ...pending } = index.pending;
    void _done;
    return {
      ...index,
      items: {
        ...index.items,
        [parsed.itemId]: {
          eTag: parsed.eTag,
          kind: parsed.kind,
          preparedAt: parsed.preparedAt,
          ...(parsed.model && { model: parsed.model }),
          chars: parsed.text.length,
          name,
        },
      },
      pending,
    };
  });
}

/** Removes every derived blob of an agent (agent delete). Best-effort. */
export async function deleteDerivedForAgent(
  storage: BlobStorage,
  agentId: string,
): Promise<void> {
  const names = await storage.listBlobs(
    `${AGENT_ACCESS_M365_DERIVED_PREFIX}${agentId}/`,
  );
  await Promise.all(
    names.map((name) =>
      withAzureRetry(() => storage.deleteIfExists(name), {
        label: 'agentAccess.deleteM365DerivedText',
      }),
    ),
  );
}
