import { checkAuxiliaryRouterEndpoints } from '@/lib/services/chat/auxiliaryRouterStartupCheck';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/ServiceContainer', () => ({
  ServiceContainer: {
    getInstance: () => ({ getChatClientsForRegion: () => ({}) }),
  },
}));

const fakeClient = { chat: { completions: { create: vi.fn() } } } as any;

describe('auxiliary router startup check', () => {
  it('warns per region: missing endpoint, failing probe, healthy endpoint', async () => {
    const log = { log: vi.fn(), warn: vi.fn() };
    const outcomes = await checkAuxiliaryRouterEndpoints({
      getClient: (region) => (region === 'EU' ? fakeClient : undefined),
      probe: async () => {
        throw Object.assign(new Error('DeploymentNotFound'), { status: 404 });
      },
      log,
    });
    expect(outcomes).toEqual({ US: 'missing', EU: 'failed' });
    const warnings = log.warn.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((w) => /No US auxiliary endpoint/.test(w))).toBe(true);
    expect(
      warnings.some((w) =>
        /EU auxiliary endpoint FAILED.*deployment_missing/.test(w),
      ),
    ).toBe(true);
    expect(log.log).not.toHaveBeenCalled();
  });

  it('logs success when the probe resolves', async () => {
    const log = { log: vi.fn(), warn: vi.fn() };
    const outcomes = await checkAuxiliaryRouterEndpoints({
      getClient: () => fakeClient,
      probe: async () => undefined,
      log,
    });
    expect(outcomes).toEqual({ US: 'ok', EU: 'ok' });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledTimes(2);
  });
});
