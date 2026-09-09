import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import {
  getCurrentEnvironment,
  getDefaultModel,
  getFallbackChain,
  getFallbackModel,
  getModelConfig,
  isDeploymentNotFoundError,
  isModelDisabled,
} from '@/config/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('isDeploymentNotFoundError', () => {
  it('detects the DeploymentNotFound code', () => {
    expect(isDeploymentNotFoundError({ code: 'DeploymentNotFound' })).toBe(
      true,
    );
  });

  it('detects a 404 whose message names a missing deployment', () => {
    expect(
      isDeploymentNotFoundError({
        status: 404,
        message: 'The API deployment for this resource does not exist.',
      }),
    ).toBe(false); // message must mention "deployment ... not found"
    expect(
      isDeploymentNotFoundError({
        status: 404,
        message: 'Deployment gpt-5.2-chat not found',
      }),
    ).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isDeploymentNotFoundError({ status: 429 })).toBe(false);
    expect(isDeploymentNotFoundError(new Error('rate limited'))).toBe(false);
    expect(isDeploymentNotFoundError(null)).toBe(false);
    expect(isDeploymentNotFoundError(undefined)).toBe(false);
  });
});

describe('Model Configuration', () => {
  beforeEach(() => {
    // Reset environment variable mocks
    vi.unstubAllEnvs();
  });

  describe('getCurrentEnvironment', () => {
    it('returns prod for production environment', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'production');
      expect(getCurrentEnvironment()).toBe('prod');
    });

    it('returns prod for prod environment', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      expect(getCurrentEnvironment()).toBe('prod');
    });

    it('returns dev for dev environment', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'dev');
      expect(getCurrentEnvironment()).toBe('dev');
    });

    it('returns localhost as default', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', undefined);
      expect(getCurrentEnvironment()).toBe('localhost');
    });

    it('returns localhost for undefined environment', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'random');
      expect(getCurrentEnvironment()).toBe('localhost');
    });
  });

  describe('getDefaultModel', () => {
    // The cost-policy preference (DEFAULT_MODEL_PREFERENCE, currently
    // gpt-5.4) wins in every ring where it is present; the dynamic
    // latest-standard-GPT rule is the tail behavior when no preference
    // resolves. These pins move when the preference list changes; that's
    // the feature, not drift.
    it('returns the preferred default for localhost', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', undefined);
      expect(getDefaultModel()).toBe('gpt-5.4');
    });

    it('returns the preferred default for dev', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'dev');
      expect(getDefaultModel()).toBe('gpt-5.4');
    });

    it('returns the preferred default for prod', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      expect(getDefaultModel()).toBe('gpt-5.4');
    });

    it('returns the preferred default for production', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'production');
      expect(getDefaultModel()).toBe('gpt-5.4');
    });

    it('falls back to the latest standard GPT when the preference is not served', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      const served = [
        OpenAIModels[OpenAIModelID.GPT_5_2],
        OpenAIModels[OpenAIModelID.GPT_5],
      ];
      expect(getDefaultModel(served)).toBe('gpt-5.2');
    });

    it('skips a preference that is not selectable in the caller region', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      const served: OpenAIModel[] = [
        { ...OpenAIModels[OpenAIModelID.GPT_5_4], hostedIn: ['US'] },
        { ...OpenAIModels[OpenAIModelID.GPT_5_2], hostedIn: ['US', 'EU'] },
      ];
      expect(getDefaultModel(served, 'EU')).toBe('gpt-5.2');
      expect(getDefaultModel(served, 'US')).toBe('gpt-5.4');
    });

    it('prefers gpt-5.4 over newer served standard GPTs (cost policy)', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'dev');
      const served = [
        OpenAIModels[OpenAIModelID.GPT_5_5],
        OpenAIModels[OpenAIModelID.GPT_5_4],
      ];
      expect(getDefaultModel(served)).toBe('gpt-5.4');
    });
  });

  describe('getModelConfig', () => {
    it('returns config for current environment', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'dev');
      const config = getModelConfig();

      expect(config).toBeDefined();
      // No static override — the default resolves dynamically per ring.
      expect(config.defaultModel).toBeUndefined();
    });

    it('has NO code-level model gating for prod (deployments are the control)', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      const config = getModelConfig();

      // disabledModels is an EMERGENCY switch only — empty in normal
      // operation. Rollout = Foundry deployments + ui-ring tags.
      expect(config.disabledModels ?? []).toEqual([]);
    });
  });

  describe('isModelDisabled', () => {
    it('returns false for enabled models in prod', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      expect(isModelDisabled('gpt-5.2-chat')).toBe(false);
      expect(isModelDisabled('gpt-5.2')).toBe(false);
      expect(isModelDisabled('gpt-4.1')).toBe(false);
    });

    it('returns false when no disabled models list exists', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'localhost');
      expect(isModelDisabled('any-model')).toBe(false);
    });

    it('handles undefined gracefully', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'localhost');
      expect(isModelDisabled('test-model')).toBe(false);
    });
  });

  describe('getFallbackChain', () => {
    it('starts with the default model', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      expect(getFallbackChain()[0]).toBe(getDefaultModel());
    });

    it('contains more than one model so default-model outages have a fallback', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      expect(getFallbackChain().length).toBeGreaterThan(1);
    });
  });

  describe('getFallbackModel', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'localhost');
    });

    it('returns the first chain model (the dynamic default) when nothing is excluded', () => {
      expect(getFallbackModel([])?.id).toBe(getDefaultModel());
    });

    it('skips the model that just failed', () => {
      const failed = getFallbackChain()[0];
      const fallback = getFallbackModel([failed]);
      expect(fallback).not.toBeNull();
      expect(fallback?.id).not.toBe(failed);
      expect(fallback?.id).toBe(getFallbackChain()[1]);
    });

    it('walks past every already-attempted model', () => {
      const chain = getFallbackChain();
      const attempted = chain.slice(0, chain.length - 1);
      expect(getFallbackModel(attempted)?.id).toBe(chain[chain.length - 1]);
    });

    it('returns null when the whole chain has been attempted', () => {
      expect(getFallbackModel(getFallbackChain())).toBeNull();
    });

    it('never returns a model from the exclude list', () => {
      const chain = getFallbackChain();
      for (let i = 0; i < chain.length; i++) {
        const excluded = chain.slice(0, i + 1);
        const fallback = getFallbackModel(excluded);
        if (fallback) {
          expect(excluded).not.toContain(fallback.id);
        }
      }
    });
  });

  describe('dynamic fallback (served model list)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
    });

    const mkModel = (
      id: string,
      over: Partial<OpenAIModel> = {},
    ): OpenAIModel =>
      ({
        id,
        name: id,
        maxLength: 100000,
        tokenLimit: 16000,
        ...over,
      }) as OpenAIModel;

    // A served ring where the static chain has rotted: no gpt-5.2*, no
    // gpt-5-mini, DeepSeek-V3.1 gone (deprecated). The latest standard GPT
    // is gpt-5.6-sol.
    const served: OpenAIModel[] = [
      mkModel('gpt-5.6-sol', {
        series: 'gpt',
        variant: 'standard',
        versionLabel: '5.6',
      }),
      mkModel('gpt-5.5', {
        series: 'gpt',
        variant: 'standard',
        versionLabel: '5.5',
      }),
      mkModel('DeepSeek-V3.2', { series: 'deepseek', versionLabel: '3.2' }),
      mkModel('my-org-agent', { isOrganizationAgent: true }),
      mkModel('o3-batch', { stream: false, versionLabel: '3' }),
    ];

    it('leads with the served default and never names an unserved model', () => {
      const chain = getFallbackChain(served);
      expect(chain[0]).toBe('gpt-5.6-sol');
      const servedIds = new Set(served.map((m) => m.id));
      for (const id of chain) {
        expect(servedIds.has(id)).toBe(true);
      }
    });

    it('extends the chain past the rotted static tail with eligible served models', () => {
      const chain = getFallbackChain(served);
      // GPT models first (newest first), then other providers; agents and
      // non-streaming models never appear.
      expect(chain).toEqual(['gpt-5.6-sol', 'gpt-5.5', 'DeepSeek-V3.2']);
    });

    it('resolves discovered-only models that are absent from the static catalog', () => {
      const fallback = getFallbackModel(['gpt-5.6-sol'], [], {
        availableModels: served,
      });
      expect(fallback?.id).toBe('gpt-5.5');
    });

    it('tries the preferred default (user setting) before the chain', () => {
      const fallback = getFallbackModel(['gpt-5.6-sol'], [], {
        availableModels: served,
        preferredDefaultId: 'DeepSeek-V3.2',
      });
      expect(fallback?.id).toBe('DeepSeek-V3.2');
    });

    it('skips the preferred default when it is the model that just failed', () => {
      const fallback = getFallbackModel(['DeepSeek-V3.2'], [], {
        availableModels: served,
        preferredDefaultId: 'DeepSeek-V3.2',
      });
      expect(fallback?.id).toBe('gpt-5.6-sol');
    });

    it('skips the preferred default when it is not fallback-eligible', () => {
      const fallback = getFallbackModel([], [], {
        availableModels: served,
        preferredDefaultId: 'my-org-agent',
      });
      expect(fallback?.id).toBe('gpt-5.6-sol');
    });

    it('respects the user region', () => {
      const regional: OpenAIModel[] = [
        mkModel('gpt-5.6-sol', {
          series: 'gpt',
          variant: 'standard',
          versionLabel: '5.6',
          hostedIn: ['US'],
        }),
        mkModel('gpt-5.5', {
          series: 'gpt',
          variant: 'standard',
          versionLabel: '5.5',
          hostedIn: ['US', 'EU'],
        }),
      ];
      const fallback = getFallbackModel([], [], {
        availableModels: regional,
        userRegion: 'EU',
      });
      expect(fallback?.id).toBe('gpt-5.5');
    });

    it('returns null when every served model has been attempted', () => {
      const fallback = getFallbackModel(
        ['gpt-5.6-sol', 'gpt-5.5', 'DeepSeek-V3.2'],
        [],
        { availableModels: served },
      );
      expect(fallback).toBeNull();
    });
  });

  describe('Default Model Properties', () => {
    it('default model is always a ring-enabled standard-variant GPT', () => {
      const environments = ['localhost', 'dev', 'prod', 'production'];

      environments.forEach((env) => {
        if (env === 'localhost') {
          vi.stubEnv('NEXT_PUBLIC_ENV', undefined);
        } else {
          vi.stubEnv('NEXT_PUBLIC_ENV', env);
        }

        const defaultModel = getDefaultModel();
        const model = OpenAIModels[defaultModel as OpenAIModelID];
        expect(model).toBeDefined();
        expect(model.series).toBe('gpt');
        expect(model.variant).toBe('standard');
        expect(model.isDisabled).not.toBe(true);
        expect(isModelDisabled(defaultModel)).toBe(false);
      });
    });
  });
});
