import { WebSearchConfigService } from '@/lib/services/webSearch/config/WebSearchConfigService';
import {
  findAssessorModel,
  isAllowedAssessorModel,
  listAssessorModels,
} from '@/lib/services/webSearch/config/assessorModels';
import {
  ASSESSOR_FALLBACK_MODEL_ID,
  DEFAULT_ASSESSOR_MODEL_ID,
  MULTI_STEP_DEFAULTS,
  WebSearchConfig,
  WebSearchConfigSchema,
  resolveMultiStepConfig,
} from '@/lib/services/webSearch/config/types';
import { readWebSearchConfig } from '@/lib/services/webSearch/config/webSearchConfigStore';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/webSearch/config/webSearchConfigStore', () => ({
  createWebSearchConfigBlobStorage: vi.fn(() => ({})),
  readWebSearchConfig: vi.fn(),
}));

const config = (multiStep: WebSearchConfig['multiStep']): WebSearchConfig => ({
  version: 1,
  multiStep,
  updatedBy: 'admin@example.com',
  updatedAt: '2026-09-30T00:00:00.000Z',
});

describe('web search config resolution', () => {
  it('falls back to the code defaults with no document', () => {
    expect(resolveMultiStepConfig(null)).toEqual(MULTI_STEP_DEFAULTS);
    expect(MULTI_STEP_DEFAULTS.enabled).toBe(true);
  });

  it('stored values override individually; the rest keep their defaults', () => {
    const resolved = resolveMultiStepConfig(
      config({ enabled: false, maxSteps: 2, assessorModelId: 'gpt-5.4-mini' }),
    );
    expect(resolved).toEqual({
      ...MULTI_STEP_DEFAULTS,
      enabled: false,
      maxSteps: 2,
      assessorModelId: 'gpt-5.4-mini',
    });
  });

  it('the exploratory cap can never undercut the normal cap', () => {
    const resolved = resolveMultiStepConfig(
      config({ maxSteps: 7, maxStepsExploratory: 4 }),
    );
    expect(resolved.maxStepsExploratory).toBe(7);
  });

  it('a stored assessor the catalog no longer offers resolves to the default', () => {
    const resolved = resolveMultiStepConfig(
      config({ assessorModelId: 'retired-model' }),
      isAllowedAssessorModel,
    );
    expect(resolved.assessorModelId).toBe(DEFAULT_ASSESSOR_MODEL_ID);
  });

  it('one malformed field defaults alone instead of voiding the document', () => {
    const parsed = WebSearchConfigSchema.parse({
      version: 1,
      multiStep: { maxSteps: 99, enabled: 'yes', timeBudgetSeconds: 45 },
      updatedBy: 'admin@example.com',
      updatedAt: '2026-09-30T00:00:00.000Z',
    });
    const resolved = resolveMultiStepConfig(parsed);
    expect(resolved.maxSteps).toBe(MULTI_STEP_DEFAULTS.maxSteps);
    expect(resolved.enabled).toBe(MULTI_STEP_DEFAULTS.enabled);
    expect(resolved.timeBudgetSeconds).toBe(45);
  });
});

describe('assessor model candidates', () => {
  it('offers the default and the fallback', () => {
    expect(isAllowedAssessorModel(DEFAULT_ASSESSOR_MODEL_ID)).toBe(true);
    expect(isAllowedAssessorModel(ASSESSOR_FALLBACK_MODEL_ID)).toBe(true);
  });

  it('excludes Claude models, dedicated reasoners and unknown ids', () => {
    const ids = listAssessorModels().map((model) => model.id);
    expect(ids.some((id) => id.startsWith('claude-'))).toBe(false);
    expect(ids).not.toContain('o3');
    expect(ids).not.toContain('DeepSeek-R1');
    expect(findAssessorModel('not-a-model')).toBeUndefined();
  });
});

describe('WebSearchConfigService', () => {
  beforeEach(() => {
    WebSearchConfigService.resetInstance();
    vi.mocked(readWebSearchConfig).mockReset();
  });

  it('serves the code defaults when nothing has been authored', async () => {
    vi.mocked(readWebSearchConfig).mockResolvedValue(null);
    const service = WebSearchConfigService.getInstance();
    await service.ensureFresh();
    expect(service.getMultiStep()).toEqual(MULTI_STEP_DEFAULTS);
  });

  it('serves the code defaults when storage is down on cold start', async () => {
    vi.mocked(readWebSearchConfig).mockRejectedValue(new Error('boom'));
    const service = WebSearchConfigService.getInstance();
    await service.ensureFresh();
    expect(service.getMultiStep()).toEqual(MULTI_STEP_DEFAULTS);
    // The failure cooldown keeps the next request from retrying at once.
    await service.ensureFresh();
    expect(readWebSearchConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps last-known-good across a failed refresh', async () => {
    vi.mocked(readWebSearchConfig).mockResolvedValueOnce({
      config: config({ enabled: false }),
      etag: '"1"',
    });
    const service = WebSearchConfigService.getInstance();
    await service.ensureFresh();
    expect(service.getMultiStep().enabled).toBe(false);

    vi.mocked(readWebSearchConfig).mockRejectedValue(new Error('boom'));
    service.invalidate();
    await service.ensureFresh();
    expect(service.getMultiStep().enabled).toBe(false);
  });

  it('invalidate() forces a refetch; a warm cache does not', async () => {
    vi.mocked(readWebSearchConfig).mockResolvedValueOnce(null);
    const service = WebSearchConfigService.getInstance();
    await service.ensureFresh();

    vi.mocked(readWebSearchConfig).mockResolvedValueOnce({
      config: config({ maxSteps: 5 }),
      etag: '"2"',
    });
    await service.ensureFresh();
    expect(service.getMultiStep().maxSteps).toBe(MULTI_STEP_DEFAULTS.maxSteps);
    service.invalidate();
    await service.ensureFresh();
    expect(service.getMultiStep().maxSteps).toBe(5);
  });

  it('does not hold a search hostage to a slow cold read', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(readWebSearchConfig).mockReturnValue(new Promise(() => {}));
      const service = WebSearchConfigService.getInstance();
      const pending = service.ensureFresh();
      await vi.advanceTimersByTimeAsync(3_000);
      await pending;
      expect(service.getMultiStep()).toEqual(MULTI_STEP_DEFAULTS);
    } finally {
      vi.useRealTimers();
    }
  });
});
