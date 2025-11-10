import { act, renderHook } from '@testing-library/react';

import { useSettings } from '@/client/hooks/settings/useSettings';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('useSettings', () => {
  beforeEach(() => {
    // Reset settings store before each test
    useSettingsStore.getState().resetSettings();
  });

  describe('State Access', () => {
    it('provides temperature from store', () => {
      const { result } = renderHook(() => useSettings());

      expect(result.current.temperature).toBeDefined();
      expect(typeof result.current.temperature).toBe('number');
    });

    it('provides systemPrompt from store', () => {
      const { result } = renderHook(() => useSettings());

      expect(result.current.systemPrompt).toBeDefined();
      expect(typeof result.current.systemPrompt).toBe('string');
    });

    it('provides defaultModelId from store', () => {
      const { result } = renderHook(() => useSettings());

      // defaultModelId can be undefined initially
      expect(result.current).toHaveProperty('defaultModelId');
    });

    it('provides models from store', () => {
      const { result } = renderHook(() => useSettings());

      expect(result.current.models).toBeDefined();
      expect(Array.isArray(result.current.models)).toBe(true);
    });

    it('provides prompts from store', () => {
      const { result } = renderHook(() => useSettings());

      expect(result.current.prompts).toBeDefined();
      expect(Array.isArray(result.current.prompts)).toBe(true);
    });
  });

  describe('Actions', () => {
    it('provides setTemperature action', () => {
      const { result } = renderHook(() => useSettings());

      expect(typeof result.current.setTemperature).toBe('function');
    });

    it('setTemperature updates temperature', () => {
      const { result } = renderHook(() => useSettings());

      act(() => {
        result.current.setTemperature(0.8);
      });

      expect(result.current.temperature).toBe(0.8);
    });

    it('provides setSystemPrompt action', () => {
      const { result } = renderHook(() => useSettings());

      expect(typeof result.current.setSystemPrompt).toBe('function');
    });

    it('setSystemPrompt updates system prompt', () => {
      const { result } = renderHook(() => useSettings());

      const newPrompt = 'You are a helpful assistant';
      act(() => {
        result.current.setSystemPrompt(newPrompt);
      });

      expect(result.current.systemPrompt).toBe(newPrompt);
    });

    it('provides setDefaultModelId action', () => {
      const { result } = renderHook(() => useSettings());

      expect(typeof result.current.setDefaultModelId).toBe('function');
    });

    it('provides setModels action', () => {
      const { result } = renderHook(() => useSettings());

      expect(typeof result.current.setModels).toBe('function');
    });

    it('provides addPrompt action', () => {
      const { result } = renderHook(() => useSettings());

      expect(typeof result.current.addPrompt).toBe('function');
    });

    it('provides updatePrompt action', () => {
      const { result } = renderHook(() => useSettings());

      expect(typeof result.current.updatePrompt).toBe('function');
    });

    it('provides deletePrompt action', () => {
      const { result } = renderHook(() => useSettings());

      expect(typeof result.current.deletePrompt).toBe('function');
    });

    it('provides resetSettings action', () => {
      const { result } = renderHook(() => useSettings());

      expect(typeof result.current.resetSettings).toBe('function');
    });
  });

  describe('Integration with Store', () => {
    it('reflects changes made directly to store', () => {
      const { result } = renderHook(() => useSettings());

      act(() => {
        useSettingsStore.getState().setTemperature(0.9);
      });

      expect(result.current.temperature).toBe(0.9);
    });

    it('multiple hook instances share same store', () => {
      const { result: result1 } = renderHook(() => useSettings());
      const { result: result2 } = renderHook(() => useSettings());

      act(() => {
        result1.current.setTemperature(0.75);
      });

      expect(result2.current.temperature).toBe(0.75);
    });

    it('resetSettings resets all settings', () => {
      const { result } = renderHook(() => useSettings());

      const initialTemp = result.current.temperature;
      const initialPrompt = result.current.systemPrompt;

      act(() => {
        result.current.setTemperature(0.5);
        result.current.setSystemPrompt('Custom prompt');
      });

      expect(result.current.temperature).toBe(0.5);
      expect(result.current.systemPrompt).toBe('Custom prompt');

      act(() => {
        result.current.resetSettings();
      });

      expect(result.current.temperature).toBe(initialTemp);
      expect(result.current.systemPrompt).toBe(initialPrompt);
    });
  });

  describe('Type Safety', () => {
    it('returns object with expected properties', () => {
      const { result } = renderHook(() => useSettings());

      const expectedProperties = [
        'temperature',
        'systemPrompt',
        'defaultModelId',
        'models',
        'prompts',
        'setTemperature',
        'setSystemPrompt',
        'setDefaultModelId',
        'setModels',
        'addPrompt',
        'updatePrompt',
        'deletePrompt',
        'resetSettings',
      ];

      expectedProperties.forEach((prop) => {
        expect(result.current).toHaveProperty(prop);
      });
    });
  });

  describe('Edge Cases', () => {
    it('handles rapid temperature changes', () => {
      const { result } = renderHook(() => useSettings());

      act(() => {
        result.current.setTemperature(0.1);
        result.current.setTemperature(0.5);
        result.current.setTemperature(0.9);
        result.current.setTemperature(0.7);
      });

      expect(result.current.temperature).toBe(0.7);
    });

    it('handles empty system prompt', () => {
      const { result } = renderHook(() => useSettings());

      act(() => {
        result.current.setSystemPrompt('');
      });

      expect(result.current.systemPrompt).toBe('');
    });
  });
});
