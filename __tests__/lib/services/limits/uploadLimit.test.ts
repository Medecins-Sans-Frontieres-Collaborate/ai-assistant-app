import { resolveEffectiveUploadMegabytes } from '@/lib/services/limits/uploadLimit';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const policyRef = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/services/limits/enforcement', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/limits/enforcement')>();
  return { ...actual, currentPolicy: vi.fn(async () => policyRef.current) };
});
vi.mock('@/lib/services/limits/principal', () => ({
  buildPrincipal: vi.fn(() => ({
    userId: 'oid-1',
    attributes: [],
    groupIds: [],
  })),
}));

function policy(mode: 'observe' | 'enforce') {
  return {
    version: 1,
    defaults: [
      { limitKey: 'feature.upload.megabytesPerFile', value: 5, ceiling: false },
    ],
    overrides: [],
    delegations: [],
    mode,
    failMode: 'open',
    timezone: 'UTC',
    countByomUsage: false,
    countAuxiliaryUsage: false,
    updatedBy: 'x',
    updatedAt: 'x',
  };
}

const session = { user: { id: 'oid-1' } } as never;

/**
 * Observe mode must change nothing for users: the per-file cap is not
 * applied, but an over-cap file still produces the would-block audit line
 * an admin is watching for.
 */
describe('resolveEffectiveUploadMegabytes', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('applies the cap in enforce mode and records the block for an over-cap file', async () => {
    policyRef.current = policy('enforce');
    expect(
      await resolveEffectiveUploadMegabytes(session, 6 * 1024 * 1024),
    ).toBe(5);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('decision=block'));
  });

  it('applies NO cap in observe mode but audits the would-block', async () => {
    policyRef.current = policy('observe');
    expect(
      await resolveEffectiveUploadMegabytes(session, 6 * 1024 * 1024),
    ).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('decision=would-block'),
    );
  });

  it('audits nothing for a file under the cap', async () => {
    policyRef.current = policy('enforce');
    expect(await resolveEffectiveUploadMegabytes(session, 1024 * 1024)).toBe(5);
    expect(log).not.toHaveBeenCalled();
  });
});
