/**
 * Where a Text only document translation keeps its files: the translated
 * document and the original it was made from, per job, under the person's
 * own prefix, until they expire (TRANSLATION_EXPIRY_DAYS).
 *
 * Both are document sources (THE DOCUMENT SOURCE), so the documents layer
 * can show them: `translation` is the translated file and
 * `translation-original` the original, each with the job id as its id.
 */
import { Session } from 'next-auth';

import type { DocumentSourceReader } from '@/lib/services/documents/sources/documentSources';

import { getEnvVariable } from '@/lib/utils/app/env';
import { AzureBlobStorage, BlobProperty } from '@/lib/utils/server/blob/blob';
import { isSafeBlobPathId } from '@/lib/utils/shared/blobPath';

import { env } from '@/config/environment';

/** The store translations are kept in, as the signed-in person. */
export function translationOutputStorage(
  user: NonNullable<Session['user']>,
): AzureBlobStorage {
  return new AzureBlobStorage(
    getEnvVariable({ name: 'AZURE_BLOB_STORAGE_NAME', user }),
    getEnvVariable({
      name: 'AZURE_BLOB_STORAGE_CONTAINER',
      throwErrorOnFail: false,
      defaultValue: env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER ?? '',
      user,
    }),
    user,
  );
}

/**
 * A job's file in the store.
 *
 * @param userId - The owner.
 * @param jobId - A safe job id (isSafeBlobPathId).
 * @param ext - A sanitized extension.
 * @param original - The original document rather than the translation.
 */
export function translationOutputPath(
  userId: string,
  jobId: string,
  ext: string,
  original: boolean,
): string {
  return original
    ? `${userId}/translations/${jobId}_original.${ext}`
    : `${userId}/translations/${jobId}.${ext}`;
}

/**
 * Formats an original may be kept in when its translation is of `type`:
 * the service translates a legacy file (.ppt, .doc) as its modern format,
 * while the original is kept as it was uploaded.
 */
const ORIGINAL_TYPES: Readonly<Record<string, readonly string[]>> = {
  pptx: ['pptx', 'ppt'],
  docx: ['docx', 'doc'],
  xlsx: ['xlsx', 'xls'],
};

function outputReader(kind: string, original: boolean): DocumentSourceReader {
  return {
    kind,
    async read(session, source) {
      const userId = session.user?.id;
      if (!userId || !isSafeBlobPathId(source.id)) return null;
      const storage = translationOutputStorage(session.user);
      const types = original
        ? (ORIGINAL_TYPES[source.type] ?? [source.type])
        : [source.type];
      for (const type of types) {
        const blobPath = translationOutputPath(
          userId,
          source.id,
          type,
          original,
        );
        if (!(await storage.blobExists(blobPath))) continue;
        const data = (await storage.get(blobPath, BlobProperty.BLOB)) as Buffer;
        return { data, type };
      }
      return null;
    },
  };
}

/** A Text only translation's translated document. */
export const translationOutputSource = outputReader('translation', false);

/** The original a Text only translation was made from. */
export const translationOriginalSource = outputReader(
  'translation-original',
  true,
);
