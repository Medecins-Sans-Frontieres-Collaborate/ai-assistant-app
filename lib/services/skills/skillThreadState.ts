/**
 * What a persisted Foundry agent thread has already been told about skills
 * (docs/SKILLS_DESIGN.md §5.4). Foundry conversations outlive requests, so
 * re-posting the catalog and the forced/`always` preloads on every turn
 * would pile up bodies in the thread. This record remembers the catalog
 * summaries and the preloaded skill versions the thread holds; the handler
 * posts only deltas and skips preloads whose body is already present and
 * unchanged. Expired records are swept by skillMaintenance.
 */
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import type { SkillCatalogSummary } from './skillCatalogSummary';

import { createHash } from 'crypto';
import { z } from 'zod';

export const SKILL_THREAD_PREFIX = 'system/agent-access/skill-threads/';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const StateSchema = z.object({
  version: z.literal(1),
  catalog: z
    .array(
      z.object({ id: z.string(), name: z.string(), description: z.string() }),
    )
    .max(200),
  /** Skill id → `updatedAt` of the body already in the thread. */
  preloaded: z.record(z.string(), z.string()).default({}),
  expiresAt: z.number(),
});
export type SkillThreadState = z.infer<typeof StateSchema>;

export function skillThreadStatePath(
  userKey: string,
  conversationId: string,
): string {
  const digest = createHash('sha256')
    .update(`${userKey}|${conversationId}`)
    .digest('hex');
  return `${SKILL_THREAD_PREFIX}${digest}.json`;
}

export async function readSkillThreadState(
  storage: BlobStorage,
  userKey: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<{ state: SkillThreadState; etag: string } | null> {
  const blob = await downloadBlob(
    storage,
    skillThreadStatePath(userKey, conversationId),
    'skills.threadState.read',
    { maxBytes: 256 * 1024, abortSignal: signal },
  );
  if (!blob) return null;
  const parsed = StateSchema.safeParse(
    JSON.parse(blob.buffer.toString('utf8')),
  );
  if (!parsed.success || parsed.data.expiresAt <= Date.now()) return null;
  return { state: parsed.data, etag: blob.etag };
}

/** Best effort: a lost race means another replica recorded a superset. */
export async function writeSkillThreadState(
  storage: BlobStorage,
  userKey: string,
  conversationId: string,
  input: { catalog: SkillCatalogSummary[]; preloaded: Record<string, string> },
  etag: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const state: SkillThreadState = {
    version: 1,
    catalog: input.catalog,
    preloaded: input.preloaded,
    expiresAt: Date.now() + TTL_MS,
  };
  try {
    await uploadJson(
      storage,
      skillThreadStatePath(userKey, conversationId),
      state,
      etag,
      'skills.threadState.write',
      { abortSignal: signal },
    );
  } catch (error) {
    if (!(error instanceof AgentAccessConflictError)) throw error;
  }
}
