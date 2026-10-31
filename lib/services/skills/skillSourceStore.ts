/**
 * Skill sources (docs/SKILLS_DESIGN.md §12): external catalogs an admin
 * subscribes the organization to. One CAS document lists the sources and
 * their last sync outcome; the skills they deliver are ordinary
 * organization skills carrying a `source` reference. Global-admin only.
 */
import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import {
  SKILL_LIMITS,
  SkillSource,
  SkillSourcesDocument,
  SkillSourcesDocumentSchema,
} from './types';

export const SKILL_SOURCES_PATH = 'system/agent-access/skill-sources.json';
const EMPTY: SkillSourcesDocument = { version: 1, sources: [] };

export interface SkillSourcesRead {
  document: SkillSourcesDocument;
  /** null when the document does not exist yet (first write creates it). */
  etag: string | null;
}

export async function readSkillSources(
  storage: BlobStorage,
  signal?: AbortSignal,
): Promise<SkillSourcesRead> {
  const blob = await downloadBlob(
    storage,
    SKILL_SOURCES_PATH,
    'skills.sources.read',
    {
      maxBytes: 512 * 1024,
      abortSignal: signal ?? AbortSignal.timeout(10_000),
    },
  );
  if (!blob) return { document: EMPTY, etag: null };
  const parsed = SkillSourcesDocumentSchema.safeParse(
    JSON.parse(blob.buffer.toString('utf8')),
  );
  if (!parsed.success) {
    // A corrupt document must not be silently replaced: surface it and let
    // an admin fix storage. Reads degrade to "no sources".
    console.error('[skills] Skill sources document is invalid', parsed.error);
    return { document: EMPTY, etag: blob.etag };
  }
  return { document: parsed.data, etag: blob.etag };
}

/** Writes the whole document under CAS; `etag` null = create. */
export async function writeSkillSources(
  storage: BlobStorage,
  document: SkillSourcesDocument,
  etag: string | null,
): Promise<string> {
  if (document.sources.length > SKILL_LIMITS.maxSkillSources)
    throw new Error(`At most ${SKILL_LIMITS.maxSkillSources} skill sources`);
  const result = await uploadJson(
    storage,
    SKILL_SOURCES_PATH,
    SkillSourcesDocumentSchema.parse(document),
    etag,
    'skills.sources.write',
  );
  AgentAccessService.getInstance().invalidate();
  return result;
}

/**
 * Applies `update` to one source with a small CAS retry loop. Returns the
 * new source, or null when it no longer exists (removed concurrently).
 */
export async function mutateSkillSource(
  storage: BlobStorage,
  sourceId: string,
  update: (source: SkillSource) => SkillSource,
  signal?: AbortSignal,
): Promise<SkillSource | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { document, etag } = await readSkillSources(storage, signal);
    const current = document.sources.find((source) => source.id === sourceId);
    if (!current) return null;
    const next = update(current);
    try {
      await writeSkillSources(
        storage,
        {
          version: 1,
          sources: document.sources.map((source) =>
            source.id === sourceId ? next : source,
          ),
        },
        etag,
      );
      return next;
    } catch (error) {
      if (!(error instanceof AgentAccessConflictError) || attempt === 3)
        throw error;
    }
  }
  throw new AgentAccessConflictError();
}
