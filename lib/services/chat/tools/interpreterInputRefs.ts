import { FILE_COUNT_LIMITS, FILE_SIZE_LIMITS } from '@/lib/utils/app/const';

import {
  ActiveFile,
  FileMessageContent,
  ImageMessageContent,
  Message,
} from '@/types/chat';

import {
  DOCUMENTS_PER_MESSAGE_LIMIT_KEY,
  getLimitDefinition,
} from '@/config/limits';
import { generatedFileBlobId } from '@/lib/constants/generatedFiles';

/**
 * Which stored files are mounted in the code-interpreter sandbox for a turn.
 *
 * The sandbox must hold every file the model is told is in scope, not just
 * the newest upload. Before this, only the most recent message carrying
 * attachments was mounted: upload IB26 in one turn and WB27 in the next, and
 * the model saw IB26's text (via active files) but could not open it — so it
 * hand-copied FTE values from the text into a Python list, dropped one, and
 * reported a wrong total (reproduced 2026-11-07: 15.6 instead of 16.6).
 *
 * Sources, in priority order (earlier sources win the file cap):
 *  1. The most recent message with attachments — what the user just handed
 *     over, or the last upload a follow-up is about.
 *  2. The conversation's active files that the ActiveFileInjector selected
 *     for this turn (pinned first, then most recently used) — uploads from
 *     earlier turns and auto-activated generated files (issue #152).
 *  3. Files earlier interpreter runs produced (issue #126) — only when the
 *     user has attached nothing, so "fix the script you wrote" re-runs
 *     against the real file.
 *
 * Duplicates (the same blob reached through several sources) mount once.
 */

/** A stored file to mount: blob id, display name, and upload sub-folder. */
export interface InterpreterInputRef {
  /** Blob id (`<sha256>.<ext>`), the last segment of the file's app URL. */
  id: string;
  /** Name the file gets in the sandbox (`/mnt/data/<filename>`). */
  filename: string;
  /** Upload sub-folder the blob lives in: `<user>/uploads/<location>/<id>`. */
  location: 'files' | 'images';
}

/**
 * Most files mounted per turn: as many documents as anyone may attach to
 * one message (the hard ceiling of `feature.upload.documentsPerMessage`),
 * so a multi-document deliverable never loses a source to the cap — the
 * old cap of 4 left one of five annual reports outside the sandbox.
 * INTERPRETER_STAGING_MAX_BYTES still bounds the bytes uploaded.
 */
export const MAX_INTERPRETER_INPUT_FILES =
  getLimitDefinition(DOCUMENTS_PER_MESSAGE_LIMIT_KEY)?.hardCeiling ??
  FILE_COUNT_LIMITS.MAX_TOTAL_FILES;

/**
 * Most bytes staged into the sandbox per turn: room for one maximum-size
 * document plus several typical ones. Staging holds every file in memory
 * for the length of the turn, so this bounds per-request memory. (Was
 * 20MB, below a single maximum-size document.)
 */
export const INTERPRETER_STAGING_MAX_BYTES =
  2 * FILE_SIZE_LIMITS.DOCUMENT_MAX_BYTES;

/** Blob ids are content hashes plus an extension; anything else is not ours. */
const BLOB_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Blob id of an app file URL: its last path segment without query string.
 *
 * @param url - An app file URL such as `/api/file/<sha256>.xlsx`.
 * @returns The blob id, or null when the segment is not a blob id.
 */
export function blobIdFromUrl(url: string | undefined): string | null {
  const id = url?.split('?')[0].split('/').pop();
  return id && BLOB_ID_PATTERN.test(id) ? id : null;
}

/** Refs from the most recent message that carries any attachment. */
function latestAttachmentRefs(messages: Message[]): InterpreterInputRef[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    const refs: InterpreterInputRef[] = [];
    for (const item of content) {
      if (item.type === 'file_url') {
        const file = item as FileMessageContent;
        const id = blobIdFromUrl(file.url);
        if (id) {
          refs.push({
            id,
            filename: file.originalFilename || id,
            location: 'files',
          });
        }
      } else if (item.type === 'image_url') {
        const url = (item as ImageMessageContent).image_url?.url ?? '';
        // Only blob-backed references; data URLs are legacy and rare.
        const id = url.startsWith('/api/file/') ? blobIdFromUrl(url) : null;
        if (id) refs.push({ id, filename: id, location: 'images' });
      }
    }
    if (refs.length > 0) return refs;
  }
  return [];
}

/**
 * Refs for active files the injector kept this turn, pinned first, then
 * most recently used. Transcripts (`transcript://`) and inline `data:`
 * entries have no blob to mount and are skipped, as are errored files.
 */
function activeFileRefs(
  activeFiles: readonly ActiveFile[],
  droppedIds: ReadonlySet<string>,
): InterpreterInputRef[] {
  const recency = (f: ActiveFile) => Date.parse(f.lastUsedAt ?? f.addedAt) || 0;
  return activeFiles
    .filter((f) => f.status !== 'error' && !droppedIds.has(f.id))
    .filter(
      (f) => !f.url.startsWith('transcript:') && !f.url.startsWith('data:'),
    )
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) || recency(b) - recency(a),
    )
    .flatMap((f): InterpreterInputRef[] => {
      const id = blobIdFromUrl(f.url);
      if (!id) return [];
      const isImage =
        f.processedContent?.type === 'image' ||
        /^image\//i.test(f.mimeType ?? '');
      return [
        {
          id,
          filename: f.originalFilename || id,
          location: isImage ? 'images' : 'files',
        },
      ];
    });
}

/** Refs for files earlier interpreter runs produced, newest reply first. */
function generatedHistoryRefs(messages: Message[]): InterpreterInputRef[] {
  const refs: InterpreterInputRef[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    for (const record of message.toolCalls ?? []) {
      for (const file of record.generated_files ?? []) {
        const id = generatedFileBlobId(file.url);
        if (!id) continue;
        refs.push({
          id,
          filename: file.filename || id,
          location: file.is_image ? 'images' : 'files',
        });
      }
    }
  }
  return refs;
}

/**
 * Chooses the files to mount in the interpreter sandbox for this turn.
 *
 * @param input.messages - The conversation as the client sent it (not the
 *        enriched copy: processors may rewrite attachment entries there).
 * @param input.activeFiles - The conversation's active files after the
 *        ActiveFileInjector ran.
 * @param input.droppedActiveFileIds - Active files the injector left out
 *        this turn (over budget); they are not mounted either, so the
 *        sandbox never holds a file the model was not told about.
 * @param maxFiles - Cap on mounted files (default MAX_INTERPRETER_INPUT_FILES).
 * @returns Ordered, de-duplicated refs, at most `maxFiles` long.
 */
export function selectInterpreterInputRefs(
  input: {
    messages: Message[];
    activeFiles?: readonly ActiveFile[];
    droppedActiveFileIds?: readonly string[];
  },
  maxFiles: number = MAX_INTERPRETER_INPUT_FILES,
): InterpreterInputRef[] {
  const attachments = latestAttachmentRefs(input.messages);
  const candidates = [
    ...attachments,
    ...activeFileRefs(
      input.activeFiles ?? [],
      new Set(input.droppedActiveFileIds ?? []),
    ),
    ...(attachments.length === 0 ? generatedHistoryRefs(input.messages) : []),
  ];

  const selected: InterpreterInputRef[] = [];
  const seen = new Set<string>();
  for (const ref of candidates) {
    if (selected.length >= maxFiles) break;
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    selected.push(ref);
  }
  return selected;
}
