/** Real policy/state validation and CAS merging, with blob I/O mocked at its primitive seam. */
import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import {
  claimAuxiliaryProbe,
  persistAuxiliaryState,
  readAuxiliaryPolicy,
  readAuxiliaryState,
  writeAuxiliaryPolicy,
} from '@/lib/services/auxiliary/store';
import type {
  AuxiliaryObservation,
  AuxiliaryPolicy,
} from '@/lib/services/auxiliary/types';

import { auxiliaryReport } from './fixtures';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@/config/environment', () => ({ env: { NEXT_PUBLIC_ENV: 'live' } }));
vi.mock('@/lib/services/adminBlobStorage', () => ({
  createAdminBlobStorage: () => ({}),
}));
vi.mock('@/lib/services/agentAccess/blobCas', async (original) => ({
  ...(await original<typeof import('@/lib/services/agentAccess/blobCas')>()),
  downloadBlob: io.read,
  uploadJson: io.write,
}));
const blob = (data: unknown, etag = '"current"') => ({
  buffer: Buffer.from(JSON.stringify(data)),
  etag,
});
const policy = (): AuxiliaryPolicy => ({
  version: 1,
  environment: 'live',
  assignments: auxiliaryReport().effective,
  updatedAt: new Date().toISOString(),
  updatedBy: 'admin@example.com',
});
const observation = (
  success: boolean,
  checkedAt: string,
): AuxiliaryObservation => ({
  key: 'EU:classifier',
  fingerprint: 'version-1',
  operation: 'skills',
  operationRevision: 1,
  policyRevision: '"r1"',
  checkedAt,
  success,
  ...(success ? {} : { reason: 'deployment_missing' }),
  durationMs: 1,
  source: 'runtime',
  fallback: false,
});
beforeEach(() => {
  vi.clearAllMocks();
  io.read.mockResolvedValue(null);
  io.write.mockResolvedValue('"new"');
});

describe('auxiliary policy storage', () => {
  it('reads only this trusted environment and preserves the exact ETag', async () => {
    io.read.mockResolvedValue(blob(policy()));
    expect((await readAuxiliaryPolicy())?.etag).toBe('"current"');
    expect(io.read).toHaveBeenCalledWith(
      expect.anything(),
      'system/auxiliary-models/live/config.json',
      expect.anything(),
      expect.objectContaining({
        maxBytes: 65536,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });
  it('rejects foreign-environment and malformed policies instead of defaulting them', async () => {
    io.read.mockResolvedValue(blob({ ...policy(), environment: 'dev' }));
    await expect(readAuxiliaryPolicy()).rejects.toThrow('environment mismatch');
    io.read.mockResolvedValue(blob({ invalid: true }));
    await expect(readAuxiliaryPolicy()).rejects.toBeDefined();
  });
  it('uses create-only/CAS conditions and propagates conflicts', async () => {
    await writeAuxiliaryPolicy(policy(), null);
    expect(io.write.mock.calls[0][3]).toBeNull();
    io.write.mockRejectedValue(new AgentAccessConflictError());
    await expect(
      writeAuxiliaryPolicy(policy(), '"old"'),
    ).rejects.toBeInstanceOf(AgentAccessConflictError);
  });
  it('merges concurrent readiness state without overwriting a newer observation', async () => {
    const older = observation(false, '2026-11-05T00:00:00.000Z');
    const newer = observation(true, '2026-11-05T00:00:01.000Z');
    io.read.mockResolvedValue(
      blob({ observations: [newer], history: [], incidents: [] }),
    );
    await persistAuxiliaryState([older]);
    expect(io.write.mock.calls[0][2].observations[0].success).toBe(true);
  });
  it('records recovery transitions and retries bounded CAS conflicts', async () => {
    const older = observation(false, '2026-11-05T00:00:00.000Z');
    const newer = observation(true, '2026-11-05T00:00:01.000Z');
    io.read.mockResolvedValue(
      blob({ observations: [older], history: [], incidents: [] }),
    );
    io.write
      .mockRejectedValueOnce(new AgentAccessConflictError())
      .mockResolvedValue('"next"');
    await persistAuxiliaryState([newer]);
    expect(io.write).toHaveBeenCalledTimes(2);
    expect(io.write.mock.calls[1][2].incidents[0].success).toBe(true);
  });
  it('bounds stored observation collections and rejects corrupt readiness state', async () => {
    io.read.mockResolvedValue(
      blob({
        observations: Array.from({ length: 201 }, () =>
          observation(true, new Date().toISOString()),
        ),
        history: [],
      }),
    );
    await expect(readAuxiliaryState()).rejects.toBeDefined();
  });
  it('uses one stable cross-replica probe claim and refuses a recently held claim', async () => {
    io.read.mockResolvedValue(blob({ at: Date.now() }));
    expect(await claimAuxiliaryProbe('EU:classifier:routing', 60000)).toBe(
      false,
    );
    expect(io.write).not.toHaveBeenCalled();
    io.read.mockResolvedValue(blob({ at: Date.now() - 60001 }));
    expect(await claimAuxiliaryProbe('EU:classifier:routing', 60000)).toBe(
      true,
    );
    expect(io.write.mock.calls[0][3]).toBe('"current"');
  });
});
