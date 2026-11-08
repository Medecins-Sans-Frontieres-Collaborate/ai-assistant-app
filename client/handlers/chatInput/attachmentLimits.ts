import { FILE_COUNT_LIMITS } from '@/lib/utils/app/const';

import { FilePreview } from '@/types/chat';

import { isAudioVideoFileByTypeOrName } from '@/lib/constants/fileTypes';

/** The parts of a file the per-message checks look at. */
export interface AttachmentCandidate {
  name: string;
  type: string;
  size: number;
}

/** Attachment counts by the categories the limits apply to. */
interface AttachmentTally {
  images: number;
  audioVideo: number;
  documents: number;
  bytes: number;
}

/** A selection that would break a per-message limit, and why. */
export type AttachmentLimitViolation =
  | { kind: 'documents'; limit: number; total: number }
  | { kind: 'images'; limit: number; total: number }
  | { kind: 'audioVideo'; limit: number; total: number }
  | { kind: 'files'; limit: number; total: number }
  | { kind: 'size'; limitBytes: number; totalBytes: number };

/**
 * Same categorisation the server applies (countDocumentAttachments): images
 * by MIME type, audio/video by type or extension, everything else is a
 * document.
 */
function tally(files: readonly AttachmentCandidate[]): AttachmentTally {
  const counts: AttachmentTally = {
    images: 0,
    audioVideo: 0,
    documents: 0,
    bytes: 0,
  };
  for (const file of files) {
    counts.bytes += file.size;
    if (file.type.startsWith('image/')) counts.images += 1;
    else if (isAudioVideoFileByTypeOrName(file.name, file.type))
      counts.audioVideo += 1;
    else counts.documents += 1;
  }
  return counts;
}

/**
 * The composer's previews that still count toward the message: everything
 * except failed uploads (which will not be sent).
 */
function pendingAttachments(previews: readonly FilePreview[]) {
  return previews
    .filter((preview) => preview.status !== 'failed')
    .map((preview) => ({
      name: preview.name,
      type: preview.type,
      size: preview.file?.size ?? 0,
    }));
}

/**
 * The most files one message may carry: the compiled total, raised to the
 * document limit when an admin allows more documents than that.
 *
 * @param documentsPerMessage - The caller's resolved document limit.
 */
export function maxFilesPerMessage(documentsPerMessage: number): number {
  return Math.max(FILE_COUNT_LIMITS.MAX_TOTAL_FILES, documentsPerMessage);
}

/**
 * Checks a new selection against the per-MESSAGE limits, counting what is
 * already in the composer. (The checks used to look at one selection at a
 * time, so a user could exceed every cap by attaching in batches, while a
 * single selection of four documents was refused.)
 *
 * @param incoming - The files just selected, dropped or pasted.
 * @param existing - The composer's current previews.
 * @param documentsPerMessage - The caller's resolved
 *        `feature.upload.documentsPerMessage`.
 * @returns The first limit the message would exceed, or null if it fits.
 */
export function checkAttachmentLimits(
  incoming: readonly AttachmentCandidate[],
  existing: readonly FilePreview[],
  documentsPerMessage: number,
): AttachmentLimitViolation | null {
  const before = tally(pendingAttachments(existing));
  const added = tally(incoming);
  const total = {
    images: before.images + added.images,
    audioVideo: before.audioVideo + added.audioVideo,
    documents: before.documents + added.documents,
    bytes: before.bytes + added.bytes,
  };
  const files = total.images + total.audioVideo + total.documents;

  const fileLimit = maxFilesPerMessage(documentsPerMessage);
  if (files > fileLimit) {
    return { kind: 'files', limit: fileLimit, total: files };
  }
  if (added.documents > 0 && total.documents > documentsPerMessage) {
    return {
      kind: 'documents',
      limit: documentsPerMessage,
      total: total.documents,
    };
  }
  if (added.images > 0 && total.images > FILE_COUNT_LIMITS.MAX_IMAGES) {
    return {
      kind: 'images',
      limit: FILE_COUNT_LIMITS.MAX_IMAGES,
      total: total.images,
    };
  }
  if (
    added.audioVideo > 0 &&
    total.audioVideo > FILE_COUNT_LIMITS.MAX_AUDIO_VIDEO
  ) {
    return {
      kind: 'audioVideo',
      limit: FILE_COUNT_LIMITS.MAX_AUDIO_VIDEO,
      total: total.audioVideo,
    };
  }
  if (total.bytes > FILE_COUNT_LIMITS.MAX_TOTAL_SIZE) {
    return {
      kind: 'size',
      limitBytes: FILE_COUNT_LIMITS.MAX_TOTAL_SIZE,
      totalBytes: total.bytes,
    };
  }
  return null;
}

/**
 * User-facing message for a violation. English, like the rest of this
 * handler's toasts.
 *
 * @param violation - The result of checkAttachmentLimits.
 */
export function describeAttachmentLimitViolation(
  violation: AttachmentLimitViolation,
): string {
  const toMb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(0);
  switch (violation.kind) {
    case 'documents':
      return `A message can carry up to ${violation.limit} documents (this would make ${violation.total}).`;
    case 'images':
      return `A message can carry up to ${violation.limit} images (this would make ${violation.total}).`;
    case 'audioVideo':
      return `A message can carry only ${violation.limit} audio or video file.`;
    case 'files':
      return `A message can carry up to ${violation.limit} files (this would make ${violation.total}).`;
    case 'size':
      return `Attachments would total ${toMb(violation.totalBytes)}MB; the limit per message is ${toMb(violation.limitBytes)}MB.`;
  }
}
