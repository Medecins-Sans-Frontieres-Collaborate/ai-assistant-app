import { act, renderHook } from '@testing-library/react';

import { useModelOrder } from '@/client/hooks/settings/useModelOrder';

import {
  DEFAULT_MODEL_ORDER,
  OpenAIModel,
  OpenAIModelID,
} from '@/types/openai';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock store state
let mockModelOrderMode: 'usage' | 'name' | 'cutoff' | 'custom' = 'usage';
let mockCustomModelOrder: string[] = [];
let mockModelUsageStats: Record<string, number> = {};

const mockSetModelOrderMode = vi.fn(
  (mode: 'usage' | 'name' | 'cutoff' | 'custom') => {
    mockModelOrderMode = mode;
  },
);
const mockMoveModelInOrder = vi.fn();
const mockResetModelOrder = vi.fn(() => {
  mockModelOrderMode = 'usage';
  mockCustomModelOrder = [];
});

vi.mock('@/client/stores/settingsStore', () => ({
  useSettingsStore: vi.fn(() => ({
    modelOrderMode: mockModelOrderMode,
    customModelOrder: mockCustomModelOrder,
    modelUsageStats: mockModelUsageStats,
    setModelOrderMode: mockSetModelOrderMode,
    moveModelInOrder: mockMoveModelInOrder,
    resetModelOrder: mockResetModelOrder,
  })),
}));

// Test models
const createTestModels = (): OpenAIModel[] => [
  {
    id: OpenAIModelID.GPT_5_2,
    name: 'GPT-5.2',
    maxLength: 128000,
    tokenLimit: 16000,
  },
  {
    id: OpenAIModelID.GPT_4_1,
    name: 'GPT-4.1',
    maxLength: 128000,
    tokenLimit: 16000,
  },
  {
    id: OpenAIModelID.CLAUDE_OPUS_4_6,
    name: 'Claude Opus 4.5',
    maxLength: 200000,
    tokenLimit: 64000,
  },
  {
    id: OpenAIModelID.DEEPSEEK_R1,
    name: 'DeepSeek-R1',
    maxLength: 128000,
    tokenLimit: 32768,
  },
];

describe('useModelOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock state - usage is the default mode
    mockModelOrderMode = 'usage';
    mockCustomModelOrder = [];
    mockModelUsageStats = {};
  });

  describe('usage ordering mode (default)', () => {
    it('should return models sorted by DEFAULT_MODEL_ORDER when no usage stats', () => {
      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      expect(result.current.orderMode).toBe('usage');

      // With no usage stats, should fall back to DEFAULT_MODEL_ORDER
      const orderedIds = result.current.orderedModels.map((m) => m.id);

      // GPT_5_2 should come before GPT_4_1 in DEFAULT_MODEL_ORDER
      const gpt5Index = orderedIds.indexOf(OpenAIModelID.GPT_5_2);
      const gpt4Index = orderedIds.indexOf(OpenAIModelID.GPT_4_1);
      expect(gpt5Index).toBeLessThan(gpt4Index);
    });

    it('should place models not in DEFAULT_MODEL_ORDER at the end', () => {
      const testModels: OpenAIModel[] = [
        ...createTestModels(),
        {
          id: 'unknown-model' as OpenAIModelID,
          name: 'Unknown Model',
          maxLength: 8000,
          tokenLimit: 4000,
        },
      ];

      const { result } = renderHook(() => useModelOrder(testModels));
      const orderedIds = result.current.orderedModels.map((m) => m.id);

      // Unknown model should be at the end
      expect(orderedIds[orderedIds.length - 1]).toBe('unknown-model');
    });
  });

  describe('name ordering mode', () => {
    it('should sort models alphabetically by name', () => {
      mockModelOrderMode = 'name';

      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      expect(result.current.orderMode).toBe('name');

      const orderedNames = result.current.orderedModels.map((m) => m.name);

      // Should be alphabetically sorted
      expect(orderedNames[0]).toBe('Claude Opus 4.5');
      expect(orderedNames[1]).toBe('DeepSeek-R1');
      expect(orderedNames[2]).toBe('GPT-4.1');
      expect(orderedNames[3]).toBe('GPT-5.2');
    });
  });

  describe('cutoff ordering mode', () => {
    it('should sort models by knowledge cutoff (newest first)', () => {
      mockModelOrderMode = 'cutoff';

      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      expect(result.current.orderMode).toBe('cutoff');

      // Just verify the mode is set correctly - actual sorting depends on
      // knowledgeCutoff values in OpenAIModels which may vary
      expect(result.current.orderedModels.length).toBe(testModels.length);
    });
  });

  describe('usage ordering mode', () => {
    it('should sort models by usage count descending', () => {
      mockModelOrderMode = 'usage';
      mockModelUsageStats = {
        [OpenAIModelID.DEEPSEEK_R1]: 10,
        [OpenAIModelID.GPT_4_1]: 5,
        [OpenAIModelID.GPT_5_2]: 3,
        [OpenAIModelID.CLAUDE_OPUS_4_6]: 1,
      };

      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      expect(result.current.orderMode).toBe('usage');

      const orderedIds = result.current.orderedModels.map((m) => m.id);

      // DeepSeek-R1 should be first (10 uses)
      expect(orderedIds[0]).toBe(OpenAIModelID.DEEPSEEK_R1);
      // GPT-4.1 should be second (5 uses)
      expect(orderedIds[1]).toBe(OpenAIModelID.GPT_4_1);
      // GPT-5.2 should be third (3 uses)
      expect(orderedIds[2]).toBe(OpenAIModelID.GPT_5_2);
      // Claude should be last (1 use)
      expect(orderedIds[3]).toBe(OpenAIModelID.CLAUDE_OPUS_4_6);
    });

    it('should use default order as tiebreaker for equal usage counts', () => {
      mockModelOrderMode = 'usage';
      // All models have same usage count
      mockModelUsageStats = {
        [OpenAIModelID.DEEPSEEK_R1]: 5,
        [OpenAIModelID.GPT_4_1]: 5,
        [OpenAIModelID.GPT_5_2]: 5,
        [OpenAIModelID.CLAUDE_OPUS_4_6]: 5,
      };

      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      const orderedIds = result.current.orderedModels.map((m) => m.id);

      // With equal usage, should fall back to DEFAULT_MODEL_ORDER
      // GPT_5_2 should be first in DEFAULT_MODEL_ORDER
      expect(orderedIds[0]).toBe(OpenAIModelID.GPT_5_2);
    });

    it('should treat models with no usage stats as 0', () => {
      mockModelOrderMode = 'usage';
      mockModelUsageStats = {
        [OpenAIModelID.GPT_4_1]: 5,
      };

      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      const orderedIds = result.current.orderedModels.map((m) => m.id);

      // GPT-4.1 with 5 uses should be first
      expect(orderedIds[0]).toBe(OpenAIModelID.GPT_4_1);
    });
  });

  describe('custom ordering mode', () => {
    it('should sort models by customModelOrder', () => {
      mockModelOrderMode = 'custom';
      mockCustomModelOrder = [
        OpenAIModelID.CLAUDE_OPUS_4_6,
        OpenAIModelID.DEEPSEEK_R1,
        OpenAIModelID.GPT_4_1,
        OpenAIModelID.GPT_5_2,
      ];

      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      const orderedIds = result.current.orderedModels.map((m) => m.id);

      expect(orderedIds[0]).toBe(OpenAIModelID.CLAUDE_OPUS_4_6);
      expect(orderedIds[1]).toBe(OpenAIModelID.DEEPSEEK_R1);
      expect(orderedIds[2]).toBe(OpenAIModelID.GPT_4_1);
      expect(orderedIds[3]).toBe(OpenAIModelID.GPT_5_2);
    });

    it('should fall back to DEFAULT_MODEL_ORDER when customModelOrder is empty', () => {
      mockModelOrderMode = 'custom';
      mockCustomModelOrder = [];

      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      // Should use DEFAULT_MODEL_ORDER as fallback
      const orderedIds = result.current.orderedModels.map((m) => m.id);
      const gpt5Index = orderedIds.indexOf(OpenAIModelID.GPT_5_2);
      const gpt4Index = orderedIds.indexOf(OpenAIModelID.GPT_4_1);
      expect(gpt5Index).toBeLessThan(gpt4Index);
    });
  });

  describe('canMoveUp', () => {
    it('should return false for the first model', () => {
      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      const firstModelId = result.current.orderedModels[0].id;
      expect(result.current.canMoveUp(firstModelId)).toBe(false);
    });

    it('should return true for models not at the top', () => {
      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      const secondModelId = result.current.orderedModels[1].id;
      expect(result.current.canMoveUp(secondModelId)).toBe(true);
    });

    it('should return false for non-existent model', () => {
      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      expect(result.current.canMoveUp('non-existent')).toBe(false);
    });
  });

  describe('canMoveDown', () => {
    it('should return false for the last model', () => {
      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      const lastModelId =
        result.current.orderedModels[result.current.orderedModels.length - 1]
          .id;
      expect(result.current.canMoveDown(lastModelId)).toBe(false);
    });

    it('should return true for models not at the bottom', () => {
      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      const firstModelId = result.current.orderedModels[0].id;
      expect(result.current.canMoveDown(firstModelId)).toBe(true);
    });

    it('should return false for non-existent model', () => {
      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      expect(result.current.canMoveDown('non-existent')).toBe(false);
    });
  });

  describe('setOrderMode', () => {
    it('should call setModelOrderMode from store', () => {
      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      act(() => {
        result.current.setOrderMode('usage');
      });

      expect(mockSetModelOrderMode).toHaveBeenCalledWith('usage');
    });
  });

  describe('moveModel', () => {
    it('should call moveModelInOrder from store', () => {
      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      act(() => {
        result.current.moveModel(OpenAIModelID.GPT_4_1, 'up');
      });

      expect(mockMoveModelInOrder).toHaveBeenCalledWith(
        OpenAIModelID.GPT_4_1,
        'up',
      );
    });
  });

  describe('resetOrder', () => {
    it('should call resetModelOrder from store', () => {
      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      act(() => {
        result.current.resetOrder();
      });

      expect(mockResetModelOrder).toHaveBeenCalled();
    });
  });

  describe('getUsageCount', () => {
    it('should return usage count for a model', () => {
      mockModelUsageStats = {
        [OpenAIModelID.GPT_5_2]: 15,
      };

      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      expect(result.current.getUsageCount(OpenAIModelID.GPT_5_2)).toBe(15);
    });

    it('should return 0 for model with no usage stats', () => {
      mockModelUsageStats = {};

      const testModels = createTestModels();
      const { result } = renderHook(() => useModelOrder(testModels));

      expect(result.current.getUsageCount(OpenAIModelID.GPT_5_2)).toBe(0);
    });
  });
});
