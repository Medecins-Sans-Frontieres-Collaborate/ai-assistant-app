/** Resumable, CAS-claimed skill indexing. One document/batch per request. */
import { chunkDocument } from '@/lib/services/m365/agentIndexService';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';
import { loadDocument } from '@/lib/utils/server/file/fileHandling';
import { countTokens } from '@/lib/utils/server/tiktoken/tiktokenCache';
import type { UserRegion } from '@/lib/utils/shared/region';

import {
  mutateSkillDocuments,
  readPreparedSkillDocument,
  readSkillOriginal,
  writePreparedSkillDocument,
} from './skillDocumentStore';
import { skillFileExtension } from './skillFiles';
import { queueSkillCleanup } from './skillMaintenance';
import { assertSkillDataRegion } from './skillRegion';
import {
  embedSkillTexts,
  ensureSkillIndex,
  skillSearchEndpoint,
  uploadSkillChunks,
} from './skillSearch';
import { SKILL_LIMITS, SkillDocument } from './types';

import { env } from '@/config/environment';
import { randomUUID } from 'crypto';

const LEASE_MS = 120_000;

/** Retries failed documents without discarding prepared text or completed batches. */
export async function retrySkillIndex(
  storage: BlobStorage,
  skillId: string,
): Promise<void> {
  let target: string | undefined;
  try {
    target = skillSearchEndpoint();
  } catch {
    /* Inline documents do not require Search. */
  }
  await mutateSkillDocuments(storage, skillId, (skill) =>
    skill.documents.map((doc) =>
      doc.indexStatus === 'failed' ||
      (doc.indexStatus === 'indexed' &&
        (doc.embeddingRegion !== env.SKILLS_DATA_REGION ||
          doc.searchIndex !== env.SKILLS_SEARCH_INDEX ||
          (!!target && doc.searchEndpoint !== target)))
        ? {
            ...doc,
            indexStatus: 'pending',
            error: undefined,
            claim: undefined,
            leaseUntil: undefined,
            ...(doc.indexStatus === 'indexed'
              ? {
                  nextChunk: 0,
                  embeddingDeployment: undefined,
                  embeddingRegion: undefined,
                }
              : {}),
          }
        : doc,
    ),
  );
}

/**
 * Claims one pending/stale item and persists a bounded batch checkpoint.
 * Concurrent/expired workers may upload identical chunk ids, but only the
 * current claim can publish progress. Removed documents are never recreated.
 */
export async function stepSkillIndex(
  storage: BlobStorage,
  skillId: string,
  signal?: AbortSignal,
  requestRegion?: UserRegion,
): Promise<{ pending: boolean; busy: boolean }> {
  const claim = randomUUID();
  let selected: SkillDocument | undefined;
  const claimed = await mutateSkillDocuments(storage, skillId, (skill) => {
    selected = skill.documents.find(
      (doc) =>
        doc.indexStatus === 'pending' ||
        (doc.indexStatus === 'processing' &&
          (doc.leaseUntil ?? 0) < Date.now()),
    );
    if (!selected) return skill.documents;
    // Never mix a completed batch from an old/default embedding account
    // with a new regional batch. Resume legacy jobs from the first chunk.
    if (
      selected.nextChunk > 0 &&
      (selected.embeddingRegion !== env.SKILLS_DATA_REGION ||
        selected.searchEndpoint !== skillSearchEndpoint() ||
        selected.searchIndex !== env.SKILLS_SEARCH_INDEX)
    )
      selected = {
        ...selected,
        nextChunk: 0,
        embeddingDeployment: undefined,
        embeddingRegion: undefined,
      };
    return skill.documents.map((doc) =>
      doc.fileId === selected!.fileId
        ? {
            ...selected!,
            indexStatus: 'processing',
            claim,
            leaseUntil: Date.now() + LEASE_MS,
          }
        : doc,
    );
  });
  const doc = selected;
  if (!doc)
    return {
      pending: false,
      busy: claimed.documents.some((item) => item.indexStatus === 'processing'),
    };
  const deadline = AbortSignal.timeout(90_000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    let prepared = await readPreparedSkillDocument(
      storage,
      skillId,
      doc.fileId,
      abort,
    );
    if (!prepared) {
      const bytes = await readSkillOriginal(
        storage,
        skillId,
        doc.fileId,
        abort,
      );
      if (!bytes)
        throw new Error('The original resource is missing; upload it again');
      const filename = doc.filename.includes('.')
        ? doc.filename
        : `${doc.filename}.${skillFileExtension(doc.filename)}`;
      const text = await loadDocument(
        new File([new Uint8Array(bytes)], filename),
        { signal: abort },
      );
      if (!text.trim())
        throw new Error(
          'No extractable text found. Upload a text-based document or an OCR version.',
        );
      if (text.length > SKILL_LIMITS.maxExtractedChars)
        throw new Error(
          'Extracted document exceeds the indexing limit; split it into smaller references',
        );
      prepared = {
        text,
        tokens: await countTokens(text),
        chunks: chunkDocument(text, 3000, 300, true),
      };
      prepared = await writePreparedSkillDocument(
        storage,
        skillId,
        doc.fileId,
        prepared,
      );
    }
    const inline = prepared.tokens <= SKILL_LIMITS.inlineDocumentTokens;
    const deployment =
      doc.embeddingDeployment ?? env.OPENAI_EMBEDDING_DEPLOYMENT;
    let nextChunk = doc.nextChunk;
    if (!inline) {
      assertSkillDataRegion(env.SKILLS_DATA_REGION, requestRegion);
      await ensureSkillIndex(abort);
      if (
        doc.searchEndpoint &&
        doc.searchIndex &&
        (doc.searchEndpoint !== skillSearchEndpoint() ||
          doc.searchIndex !== env.SKILLS_SEARCH_INDEX)
      )
        await queueSkillCleanup(
          storage,
          skillId,
          [doc],
          Date.now() + 10 * 60 * 1000,
          true,
        );
      const checkpoint = await mutateSkillDocuments(storage, skillId, (skill) =>
        skill.documents.map((item) =>
          item.fileId === doc.fileId && item.claim === claim
            ? {
                ...item,
                chunkCount: prepared!.chunks.length,
                embeddingDeployment: deployment,
                embeddingRegion: env.SKILLS_DATA_REGION,
                searchEndpoint: skillSearchEndpoint(),
                searchIndex: env.SKILLS_SEARCH_INDEX,
              }
            : item,
        ),
      );
      if (
        !checkpoint.documents.some(
          (item) => item.fileId === doc.fileId && item.claim === claim,
        )
      )
        return {
          pending: checkpoint.documents.some(
            (item) => item.indexStatus === 'pending',
          ),
          busy: checkpoint.documents.some(
            (item) => item.indexStatus === 'processing',
          ),
        };
      const batch = prepared.chunks.slice(
        nextChunk,
        nextChunk + SKILL_LIMITS.indexBatchSize,
      );
      if (batch.length) {
        const vectors = await embedSkillTexts(
          batch.map((chunk) => chunk.chunk),
          deployment,
          abort,
        );
        await uploadSkillChunks(
          batch.map((chunk, index) => ({
            chunk_id: `${doc.fileId}_${nextChunk + index}`,
            skill_id: skillId,
            file_id: doc.fileId,
            chunk: chunk.chunk,
            locator: chunk.locator ?? '',
            text_vector: vectors[index],
          })),
          abort,
        );
        nextChunk += batch.length;
      }
    }
    const status = inline
      ? 'inline'
      : nextChunk >= prepared.chunks.length
        ? 'indexed'
        : 'pending';
    const chunkCount = prepared.chunks.length;
    await mutateSkillDocuments(storage, skillId, (skill) =>
      skill.documents.map((item) =>
        item.fileId === doc.fileId && item.claim === claim
          ? {
              ...item,
              indexStatus: status,
              nextChunk,
              chunkCount,
              embeddingDeployment: inline ? undefined : deployment,
              embeddingRegion: inline ? undefined : env.SKILLS_DATA_REGION,
              searchEndpoint: inline ? undefined : skillSearchEndpoint(),
              searchIndex: inline ? undefined : env.SKILLS_SEARCH_INDEX,
              claim: undefined,
              leaseUntil: undefined,
              error: undefined,
            }
          : item,
      ),
    );
  } catch (error) {
    await mutateSkillDocuments(storage, skillId, (skill) =>
      skill.documents.map((item) =>
        item.fileId === doc.fileId && item.claim === claim
          ? {
              ...item,
              indexStatus: 'failed',
              error:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : 'Indexing failed',
              claim: undefined,
              leaseUntil: undefined,
            }
          : item,
      ),
    );
  }
  // A fresh manifest accounts for concurrent additions/deletions.
  const latest = await mutateSkillDocuments(
    storage,
    skillId,
    (skill) => skill.documents,
  );
  return {
    pending: latest.documents.some((item) => item.indexStatus === 'pending'),
    busy: latest.documents.some((item) => item.indexStatus === 'processing'),
  };
}
