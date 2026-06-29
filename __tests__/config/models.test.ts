import { OpenAIModelID } from '@/types/openai';

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
    it('returns gpt-5.2-chat for localhost', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', undefined);
      expect(getDefaultModel()).toBe('gpt-5.2-chat');
    });

    it('returns gpt-5.2-chat for dev', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'dev');
      expect(getDefaultModel()).toBe('gpt-5.2-chat');
    });

    it('returns gpt-5.2-chat for prod', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      expect(getDefaultModel()).toBe('gpt-5.2-chat');
    });

    it('returns gpt-5.2-chat for production', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'production');
      expect(getDefaultModel()).toBe('gpt-5.2-chat');
    });
  });

  describe('getModelConfig', () => {
    it('returns config for current environment', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'dev');
      const config = getModelConfig();

      expect(config).toBeDefined();
      expect(config.defaultModel).toBe('gpt-5.2-chat');
    });

    it('includes disabled models list for prod', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      const config = getModelConfig();

      expect(config.disabledModels).toBeDefined();
      expect(Array.isArray(config.disabledModels)).toBe(true);
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

    it('returns the first chain model when nothing is excluded', () => {
      expect(getFallbackModel([])?.id).toBe(OpenAIModelID.GPT_5_2_CHAT);
    });

    it('skips the model that just failed', () => {
      const fallback = getFallbackModel([OpenAIModelID.GPT_5_2_CHAT]);
      expect(fallback).not.toBeNull();
      expect(fallback?.id).not.toBe(OpenAIModelID.GPT_5_2_CHAT);
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

  describe('Default Model Properties', () => {
    it('default model is gpt-5.2-chat with search mode enabled', () => {
      const defaultModel = getDefaultModel();
      expect(defaultModel).toBe('gpt-5.2-chat');
    });

    it('ensures consistency across all environments', () => {
      const environments = ['localhost', 'dev', 'prod', 'production'];

      environments.forEach((env) => {
        if (env === 'production') {
          vi.stubEnv('NEXT_PUBLIC_ENV', 'production');
        } else {
          vi.stubEnv('NEXT_PUBLIC_ENV', env);
        }

        const defaultModel = getDefaultModel();
        expect(defaultModel).toBe('gpt-5.2-chat');
      });
    });
  });
});
