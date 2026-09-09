import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEFAULT_MODEL resolves at module load from the env override, so each test
 * mutates the mocked env and re-imports the module.
 */
const mockEnv: Record<string, string | undefined> = {};

vi.mock('@/config/environment', () => ({
  env: mockEnv,
}));

const loadDefaultModel = async (): Promise<string> => {
  vi.resetModules();
  const { DEFAULT_MODEL } = await import('@/lib/utils/app/const');
  return DEFAULT_MODEL;
};

describe('DEFAULT_MODEL env override sense check', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete mockEnv.DEFAULT_MODEL;
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('resolves the dynamic default when no override is set', async () => {
    expect(await loadDefaultModel()).toBe('gpt-5.4');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('honors an override that names an available model', async () => {
    mockEnv.DEFAULT_MODEL = 'gpt-5-mini';
    expect(await loadDefaultModel()).toBe('gpt-5-mini');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ignores an override that is not in the catalog', async () => {
    mockEnv.DEFAULT_MODEL = 'gpt-typo-9000';
    expect(await loadDefaultModel()).toBe('gpt-5.4');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('gpt-typo-9000'),
    );
  });

  it('ignores an override naming a globally disabled model', async () => {
    mockEnv.DEFAULT_MODEL = 'grok-4';
    expect(await loadDefaultModel()).toBe('gpt-5.4');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('grok-4'));
  });
});
