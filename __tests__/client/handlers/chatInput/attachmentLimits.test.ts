import { FILE_COUNT_LIMITS } from '@/lib/utils/app/const';

import { FilePreview } from '@/types/chat';

import {
  checkAttachmentLimits,
  describeAttachmentLimitViolation,
  maxFilesPerMessage,
} from '@/client/handlers/chatInput/attachmentLimits';
import { describe, expect, it } from 'vitest';

const doc = (i: number) => ({
  name: `report_${i}.pdf`,
  type: 'application/pdf',
  size: 1024,
});
const image = (i: number) => ({
  name: `p${i}.png`,
  type: 'image/png',
  size: 1,
});
const audio = { name: 'call.mp3', type: 'audio/mpeg', size: 1 };

function previews(
  files: Array<{ name: string; type: string; size: number }>,
  status: FilePreview['status'] = 'completed',
): FilePreview[] {
  return files.map((f) => ({
    name: f.name,
    type: f.type,
    status,
    previewUrl: '',
    file: new File([new Uint8Array(f.size)], f.name, { type: f.type }),
  }));
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('checkAttachmentLimits', () => {
  it('admits exactly the documents limit in one selection and refuses one more', () => {
    expect(checkAttachmentLimits(range(5).map(doc), [], 5)).toBeNull();
    expect(checkAttachmentLimits(range(6).map(doc), [], 5)).toEqual({
      kind: 'documents',
      limit: 5,
      total: 6,
    });
  });

  it('counts documents already in the composer (no bypass by batching)', () => {
    const existing = previews(range(3).map(doc));
    expect(checkAttachmentLimits(range(2).map(doc), existing, 5)).toBeNull();
    expect(checkAttachmentLimits(range(3).map(doc), existing, 5)).toMatchObject(
      {
        kind: 'documents',
        total: 6,
      },
    );
  });

  it('does not count failed uploads', () => {
    const failed = previews(range(5).map(doc), 'failed');
    expect(checkAttachmentLimits([doc(9)], failed, 5)).toBeNull();
  });

  it('does not block images because documents are already at the limit', () => {
    const existing = previews(range(5).map(doc));
    expect(checkAttachmentLimits([image(1)], existing, 5)).toBeNull();
  });

  it('keeps the audio/video cap across batches', () => {
    expect(checkAttachmentLimits([audio], previews([audio]), 5)).toMatchObject({
      kind: 'audioVideo',
    });
  });

  it('raises the total-file cap when an admin allows more documents', () => {
    expect(maxFilesPerMessage(5)).toBe(FILE_COUNT_LIMITS.MAX_TOTAL_FILES);
    expect(maxFilesPerMessage(15)).toBe(15);
    expect(checkAttachmentLimits(range(15).map(doc), [], 15)).toBeNull();
    expect(checkAttachmentLimits(range(16).map(doc), [], 15)).toMatchObject({
      kind: 'files',
    });
  });

  it('applies the total size cap to the whole message', () => {
    const half = FILE_COUNT_LIMITS.MAX_TOTAL_SIZE / 2 + 1;
    const existing: FilePreview[] = [
      {
        ...previews([doc(0)])[0],
        file: { size: half } as File,
      },
    ];
    expect(
      checkAttachmentLimits([{ ...doc(1), size: half }], existing, 5),
    ).toMatchObject({ kind: 'size' });
  });

  it('describes a violation with the limit and the would-be total', () => {
    expect(
      describeAttachmentLimitViolation({
        kind: 'documents',
        limit: 5,
        total: 7,
      }),
    ).toContain('5 documents');
  });
});
