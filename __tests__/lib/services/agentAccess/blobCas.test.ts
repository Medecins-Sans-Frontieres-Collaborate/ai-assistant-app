import {
  AgentAccessConflictError,
  OVERWRITE_BLOB,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const upload = vi.fn();
const storage = {
  getBlockBlobClient: () => ({ upload }),
} as unknown as BlobStorage;

const azureError = (statusCode: number) =>
  Object.assign(new Error(`azure ${statusCode}`), { statusCode });

describe('uploadJson conditions', () => {
  beforeEach(() => {
    upload.mockReset();
    upload.mockResolvedValue({ etag: '"new"' });
  });

  it('creates with If-None-Match:* when the condition is null', async () => {
    await uploadJson(storage, 'p', { a: 1 }, null, 'label');
    expect(upload.mock.calls[0][2].conditions).toEqual({ ifNoneMatch: '*' });
  });

  it('updates with If-Match when an etag is given', async () => {
    await uploadJson(storage, 'p', { a: 1 }, '"e1"', 'label');
    expect(upload.mock.calls[0][2].conditions).toEqual({ ifMatch: '"e1"' });
  });

  it('writes unconditionally for OVERWRITE_BLOB (last writer wins)', async () => {
    await uploadJson(storage, 'p', { a: 1 }, OVERWRITE_BLOB, 'label');
    expect(upload.mock.calls[0][2]).not.toHaveProperty('conditions');
  });

  it("maps Azure's 409 BlobAlreadyExists on a create to the conflict error", async () => {
    upload.mockRejectedValue(azureError(409));
    await expect(
      uploadJson(storage, 'p', { a: 1 }, null, 'label'),
    ).rejects.toBeInstanceOf(AgentAccessConflictError);
  });

  it('maps 412 on an update to the conflict error, but not a 409 (not a precondition there)', async () => {
    upload.mockRejectedValue(azureError(412));
    await expect(
      uploadJson(storage, 'p', { a: 1 }, '"e1"', 'label'),
    ).rejects.toBeInstanceOf(AgentAccessConflictError);
    upload.mockRejectedValue(azureError(409));
    await expect(
      uploadJson(storage, 'p', { a: 1 }, '"e1"', 'label'),
    ).rejects.not.toBeInstanceOf(AgentAccessConflictError);
  });
});
