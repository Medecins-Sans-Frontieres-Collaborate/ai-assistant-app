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
    it('GPT-4.1 should have correct agent name with Bing grounding', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_4_1].agentId).toBe('gpt-41');
      expect(OpenAIModels[OpenAIModelID.GPT_4_1].isAgent).toBe(true);
    });

    it('GPT-5 and GPT-5 Chat should have agent capabilities', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_5_2].agentId).toBe('gpt-52');
      expect(OpenAIModels[OpenAIModelID.GPT_5_2].isAgent).toBe(true);
      expect(OpenAIModels[OpenAIModelID.GPT_5_2_CHAT].agentId).toBe(
        'gpt-52-chat',
      );
      expect(OpenAIModels[OpenAIModelID.GPT_5_2_CHAT].isAgent).toBe(true);
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
    it('GPT-4.1 should be omni model', () => {
      expect(OpenAIModels[OpenAIModelID.GPT_4_1].modelType).toBe('omni');
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
    it('all models should have knowledge cutoff dates defined', () => {
      Object.values(OpenAIModels).forEach((model) => {
        // knowledgeCutoffDate should be defined (can be empty string for agent models)
        expect(model.knowledgeCutoffDate).toBeDefined();
      });
    });

    it('knowledge cutoffs should be in ISO format or empty for agents', () => {
      Object.values(OpenAIModels).forEach((model) => {
        const cutoff = model.knowledgeCutoffDate || '';

        if (cutoff === '') {
          // Empty string is valid for agent models with real-time search
          expect(model.isAgent).toBe(true);
          return;
        }

        // ISO formats:
        // - Month only: "2025-12" or "2025-01"
        // - Date only: "2025-01-20"
        // - Date with time: "2025-08-06T20:00"
        const isMonthOnly = /^\d{4}-\d{2}$/.test(cutoff);
        const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(cutoff);
        const isDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cutoff);

        expect(isMonthOnly || isDateOnly || isDateTime).toBe(true);
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
        expect(model.knowledgeCutoffDate).toBeDefined();
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
        // Agent IDs can be new-format names (e.g., gpt-41) or legacy asst_xxx
        expect(model.agentId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
      });
    });
  });

  describe('SDK and Temperature Consistency', () => {
    it('azure-openai SDK models should not support temperature', () => {
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
