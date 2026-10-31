/** Persistent skill originals and prepared text in the lifecycle-free admin store. */
import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  readSkill,
  writeSkill,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import { checkDocumentSignature } from '@/lib/services/m365/documentSignature';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import {
  SkillResourceError,
  skillFileExtension,
  skillResourcePath,
  validateSkillFiles,
} from './skillFiles';
import { queueSkillCleanup } from './skillMaintenance';
import { Skill, SkillDocument, SkillIdSchema } from './types';
import { SKILL_LIMITS } from './types';

import { validateFileSizeRaw } from '@/lib/constants/fileLimits';
import { randomUUID } from 'crypto';
import { z } from 'zod';

/** Fixed server-owned paths; no client-supplied blob names or URLs. */
export function skillDocumentPath(
  skillId: string,
  fileId: string,
  part: 'original' | 'prepared.json',
): string {
  SkillIdSchema.parse(skillId);
  if (!/^[a-f0-9-]{36}$/.test(fileId))
    throw new Error('Invalid skill document id');
  return `system/agent-access/skill-resources/${skillId}/${fileId}/${part}`;
}

/** Validates and stores immutable originals before the skill's CAS publish. */
export async function storeSkillFiles(
  storage: BlobStorage,
  skillId: string,
  files: File[],
  userMail: string,
): Promise<SkillDocument[]> {
  validateSkillFiles(files);
  const documents: SkillDocument[] = [];
  try {
    for (const file of files) {
      const resourcePath = skillResourcePath(file.name);
      const bytes = Buffer.from(await file.arrayBuffer());
      const sizeCheck = validateFileSizeRaw(file.name, bytes.length, file.type);
      if (!sizeCheck.valid)
        throw new SkillResourceError(
          sizeCheck.error ?? 'Resource exceeds file limits',
        );
      const asset = resourcePath.startsWith('assets/');
      if (!asset) {
        const signature = checkDocumentSignature(
          bytes,
          skillFileExtension(file.name),
        );
        if (!signature.ok) throw new SkillResourceError(signature.error);
      }
      const fileId = randomUUID();
      documents.push({
        fileId,
        filename: file.name.split('/').at(-1)!,
        resourcePath,
        sizeBytes: bytes.length,
        indexStatus: asset ? 'asset' : 'pending',
        nextChunk: 0,
        uploadedAt: new Date().toISOString(),
        uploadedBy: userMail,
      });
      // A delayed intent covers process termination before manifest publish.
      // The sweep checks live membership and never deletes an attached file.
      await queueSkillCleanup(
        storage,
        skillId,
        [documents.at(-1)!],
        Date.now() + 60 * 60 * 1000,
      );
      await storage
        .getBlockBlobClient(skillDocumentPath(skillId, fileId, 'original'))
        .upload(bytes, bytes.length, {
          conditions: { ifNoneMatch: '*' },
          blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
          abortSignal: AbortSignal.timeout(30_000),
        });
    }
    return documents;
  } catch (error) {
    await discardSkillFiles(storage, skillId, documents);
    throw error;
  }
}

/** Best-effort cleanup after a failed CAS or committed removal. */
export async function discardSkillFiles(
  storage: BlobStorage,
  skillId: string,
  documents: SkillDocument[],
): Promise<void> {
  try {
    await queueSkillCleanup(
      storage,
      skillId,
      documents,
      Date.now() + 10 * 60 * 1000,
    );
  } catch (error) {
    console.error(
      '[skills] Durable resource cleanup could not be recorded',
      error,
    );
  }
  for (const document of documents) {
    for (const part of ['original', 'prepared.json'] as const) {
      try {
        await storage
          .getBlockBlobClient(skillDocumentPath(skillId, document.fileId, part))
          .deleteIfExists();
      } catch (error) {
        console.error(
          '[skills] Resource cleanup failed',
          skillId,
          document.fileId,
          error,
        );
      }
    }
  }
}

/** Reads an original through a bounded request, returning null if it was deleted. */
export async function readSkillOriginal(
  storage: BlobStorage,
  skillId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  return (
    (
      await downloadBlob(
        storage,
        skillDocumentPath(skillId, fileId, 'original'),
        'skills.original',
        {
          abortSignal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
          maxBytes: SKILL_LIMITS.maxDocumentBytes,
        },
      )
    )?.buffer ?? null
  );
}

export interface PreparedSkillDocument {
  text: string;
  tokens: number;
  chunks: { chunk: string; locator?: string }[];
}
const PreparedSkillDocumentSchema = z.object({
  text: z.string().min(1).max(SKILL_LIMITS.maxExtractedChars),
  tokens: z.number().int().nonnegative(),
  chunks: z
    .array(
      z.object({
        chunk: z.string().min(1).max(3000),
        locator: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .max(300),
});

/** Stores immutable derived text. Concurrent recoveries produce the same content. */
export async function writePreparedSkillDocument(
  storage: BlobStorage,
  skillId: string,
  fileId: string,
  prepared: PreparedSkillDocument,
): Promise<PreparedSkillDocument> {
  prepared = PreparedSkillDocumentSchema.parse(prepared);
  try {
    await uploadJson(
      storage,
      skillDocumentPath(skillId, fileId, 'prepared.json'),
      prepared,
      null,
      'skills.prepare',
    );
  } catch (error) {
    if (!(error instanceof AgentAccessConflictError)) throw error;
    const winner = await readPreparedSkillDocument(storage, skillId, fileId);
    if (!winner)
      throw new Error('Prepared document disappeared during indexing');
    return winner;
  }
  return prepared;
}

/** Loads the prepared payload separately from the lightweight skill catalog. */
export async function readPreparedSkillDocument(
  storage: BlobStorage,
  skillId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<PreparedSkillDocument | null> {
  const result = await downloadBlob(
    storage,
    skillDocumentPath(skillId, fileId, 'prepared.json'),
    'skills.prepared',
    {
      abortSignal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      maxBytes: 8 * 1024 * 1024,
    },
  );
  return result
    ? PreparedSkillDocumentSchema.parse(
        JSON.parse(result.buffer.toString('utf8')),
      )
    : null;
}

/** CAS mutation for job claims/checkpoints; concurrent admin edits are preserved. */
export async function mutateSkillDocuments(
  storage: BlobStorage,
  skillId: string,
  update: (skill: Skill) => SkillDocument[],
): Promise<Skill> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await readSkill(storage, skillId);
    if (!current) throw new Error('Skill no longer exists');
    const documents = update(current.skill);
    if (documents === current.skill.documents) return current.skill;
    const next = { ...current.skill, documents };
    try {
      await writeSkill(storage, next, current.etag);
      AgentAccessService.getInstance().invalidate();
      return next;
    } catch (error) {
      if (!(error instanceof AgentAccessConflictError) || attempt === 3)
        throw error;
    }
  }
  throw new AgentAccessConflictError();
}
