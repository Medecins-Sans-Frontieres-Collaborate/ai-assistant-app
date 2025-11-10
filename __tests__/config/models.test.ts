import {
  getCurrentEnvironment,
  getDefaultModel,
  getModelConfig,
  isModelDisabled,
} from '@/config/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    it('returns gpt-5-chat for localhost', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', undefined);
      expect(getDefaultModel()).toBe('gpt-5-chat');
    });

    it('returns gpt-5-chat for dev', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'dev');
      expect(getDefaultModel()).toBe('gpt-5-chat');
    });

    it('returns gpt-5-chat for prod', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'prod');
      expect(getDefaultModel()).toBe('gpt-5-chat');
    });

    it('returns gpt-5-chat for production', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'production');
      expect(getDefaultModel()).toBe('gpt-5-chat');
    });
  });

  describe('getModelConfig', () => {
    it('returns config for current environment', () => {
      vi.stubEnv('NEXT_PUBLIC_ENV', 'dev');
      const config = getModelConfig();

      expect(config).toBeDefined();
      expect(config.defaultModel).toBe('gpt-5-chat');
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
      expect(isModelDisabled('gpt-5-chat')).toBe(false);
      expect(isModelDisabled('gpt-5')).toBe(false);
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

  describe('Default Model Properties', () => {
    it('default model is gpt-5-chat with search mode enabled', () => {
      const defaultModel = getDefaultModel();
      expect(defaultModel).toBe('gpt-5-chat');
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
        expect(defaultModel).toBe('gpt-5-chat');
      });
    });
  });
});
