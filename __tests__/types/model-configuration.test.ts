import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { describe, expect, it } from 'vitest';

describe('Model Configuration', () => {
  describe('SDK Configuration', () => {
    it('GPT-4.1 should use azure-openai SDK', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_4_1].sdk).toBe('azure-openai');
    });

    it('GPT-5 models should use azure-openai SDK', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_5_2].sdk).toBe('azure-openai');
      expect(OpenAIModels[OpenAIModelID.GPT_5_2_CHAT].sdk).toBe('azure-openai');
    });

    it('o3 should use azure-openai SDK', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_o3].sdk).toBe('azure-openai');
    });

    it('DeepSeek should use openai SDK', () => {
      expect(OpenAIModels[OpenAIModelID.DEEPSEEK_V3_1].sdk).toBe('openai');
    });

    it('Grok models should use openai SDK', () => {
      expect(OpenAIModels[OpenAIModelID.GROK_3].sdk).toBe('openai');
    });
  });

  describe('Temperature Support', () => {
    it('GPT-4.1 should not support temperature', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_4_1].supportsTemperature).toBe(
        false,
      );
    });

    it('GPT-5 models should not support temperature', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_5_2].supportsTemperature).toBe(
        false,
      );
      expect(OpenAIModels[OpenAIModelID.GPT_5_2_CHAT].supportsTemperature).toBe(
        false,
      );
    });

    it('o3 should not support temperature', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_o3].supportsTemperature).toBe(
        false,
      );
    });

    it('DeepSeek should support temperature', () => {
      expect(
        OpenAIModels[OpenAIModelID.DEEPSEEK_V3_1].supportsTemperature,
      ).toBe(true);
    });

    it('Grok models should support temperature', () => {
      expect(OpenAIModels[OpenAIModelID.GROK_3].supportsTemperature).toBe(true);
    });
  });

  describe('Agent Configuration', () => {
    it('GPT-4.1 should have correct agent ID with Bing grounding', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_4_1].agentId).toBe(
        'asst_Puf3ldskHlYHmW5z9aQy5fZL',
      );
      expect(OpenAIModels[OpenAIModelID.GPT_4_1].isAgent).toBe(true);
      expect(OpenAIModels[OpenAIModelID.GPT_4_1].modelType).toBe('agent');
    });

    it('GPT-5 and GPT-5 Chat should not have agent capabilities', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_5_2].agentId).toBeUndefined();
      expect(OpenAIModels[OpenAIModelID.GPT_5_2].isAgent).toBeUndefined();
      expect(OpenAIModels[OpenAIModelID.GPT_5_2_CHAT].agentId).toBeUndefined();
      expect(OpenAIModels[OpenAIModelID.GPT_5_2_CHAT].isAgent).toBeUndefined();
    });

    it('non-OpenAI models should not have agent capabilities', () => {
      expect(OpenAIModels[OpenAIModelID.DEEPSEEK_V3_1].agentId).toBeUndefined();
      expect(OpenAIModels[OpenAIModelID.GROK_3].agentId).toBeUndefined();
    });
  });

  describe('Provider Configuration', () => {
    it('GPT models should have openai provider', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_4_1].provider).toBe('openai');
      expect(OpenAIModels[OpenAIModelID.GPT_5_2].provider).toBe('openai');
      expect(OpenAIModels[OpenAIModelID.GPT_5_2_CHAT].provider).toBe('openai');
      expect(OpenAIModels[OpenAIModelID.GPT_o3].provider).toBe('openai');
    });

    it('DeepSeek should have deepseek provider', () => {
      expect(OpenAIModels[OpenAIModelID.DEEPSEEK_V3_1].provider).toBe(
        'deepseek',
      );
    });

    it('Grok models should have xai provider', () => {
      expect(OpenAIModels[OpenAIModelID.GROK_3].provider).toBe('xai');
    });
  });

  describe('Model Types', () => {
    it('GPT-4.1 should be agent model', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_4_1].modelType).toBe('agent');
    });

    it('GPT-5 should be omni model', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_5_2].modelType).toBe('omni');
    });

    it('GPT-5 Chat should be omni model', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_5_2_CHAT].modelType).toBe('omni');
    });

    it('o3 should be reasoning model', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_o3].modelType).toBe('reasoning');
    });

    it('Grok 3 should be omni model', () => {
      expect(OpenAIModels[OpenAIModelID.GROK_3].modelType).toBe('omni');
    });

    it('DeepSeek should be foundational model', () => {
      expect(OpenAIModels[OpenAIModelID.DEEPSEEK_V3_1].modelType).toBe(
        'foundational',
      );
    });
  });

  describe('Knowledge Cutoffs', () => {
    it('all models should have knowledge cutoff dates', () => {
      Object.values(OpenAIModels).forEach((model) => {
        expect(model.knowledgeCutoff).toBeDefined();
        expect(model.knowledgeCutoff).not.toBe('');
      });
    });

    it('knowledge cutoffs should be properly formatted', () => {
      Object.values(OpenAIModels).forEach((model) => {
        // Should match format like "Aug 6, 2025 8:00 PM" or "May 13, 2025 12:16 AM"
        // or special cases like "Real-time web search" for agent models
        // or simplified date format like "Jan 20, 2025" for some models
        const cutoff = model.knowledgeCutoff || '';
        const isFullDateFormat =
          /^[A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2} (AM|PM)$/.test(cutoff);
        const isSimpleDateFormat = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(
          cutoff,
        );
        const isSpecialCase = cutoff === 'Real-time web search';
        expect(isFullDateFormat || isSimpleDateFormat || isSpecialCase).toBe(
          true,
        );
      });
    });
  });

  describe('Legacy Models', () => {
    it('legacy models should be explicitly marked', () => {
      Object.values(OpenAIModels).forEach((model) => {
        // isLegacy can be true (temporarily disabled), false, or undefined
        // Just verify it's a boolean or undefined
        if (model.isDisabled !== undefined) {
          expect(typeof model.isDisabled).toBe('boolean');
        }
      });
    });
  });

  describe('Model Completeness', () => {
    it('all models should have required fields', () => {
      Object.values(OpenAIModels).forEach((model) => {
        expect(model.id).toBeDefined();
        expect(model.name).toBeDefined();
        expect(model.maxLength).toBeGreaterThan(0);
        expect(model.tokenLimit).toBeGreaterThan(0);
        expect(model.description).toBeDefined();
        expect(model.provider).toBeDefined();
        expect(model.knowledgeCutoff).toBeDefined();
        expect(model.sdk).toBeDefined();
        expect(model.supportsTemperature).toBeDefined();
        // Note: searchMode is now controlled at request level via SearchMode enum, not model-level
      });
    });

    it('agent models should have agent-specific fields', () => {
      const agentModels = Object.values(OpenAIModels).filter(
        (m) => m.isAgent || m.agentId,
      );

      agentModels.forEach((model) => {
        expect(model.agentId).toBeDefined();
        expect(model.agentId).toMatch(/^asst_[A-Za-z0-9]+$/);
      });
    });
  });

  describe('SDK and Temperature Consistency', () => {
    it('azure-openai SDK models should not support temperature (OpenAI constraint)', () => {
      const azureOpenAIModels = Object.values(OpenAIModels).filter(
        (m) => m.sdk === 'azure-openai',
      );

      azureOpenAIModels.forEach((model) => {
        expect(model.supportsTemperature).toBe(false);
      });
    });

    it('openai SDK models should support temperature', () => {
      const openAISDKModels = Object.values(OpenAIModels).filter(
        (m) => m.sdk === 'openai',
      );

      openAISDKModels.forEach((model) => {
        expect(model.supportsTemperature).toBe(true);
      });
    });
  });

  describe('Reasoning Models', () => {
    it('reasoning models should have correct configuration', () => {
      const reasoningModels = Object.values(OpenAIModels).filter(
        (m) => m.modelType === 'reasoning',
      );

      reasoningModels.forEach((model) => {
        // o3 should not allow streaming
        if (model.id === OpenAIModelID.GPT_o3) {
          expect(model.stream).toBe(false);
          expect(model.temperature).toBe(1);
        }
        // Other reasoning models may allow streaming and custom temperature
      });
    });
  });
});
