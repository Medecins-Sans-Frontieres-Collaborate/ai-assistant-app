import { ToneService } from '@/lib/services/shared/ToneService';

import { Tone } from '@/types/tone';

import { beforeEach, describe, expect, it } from 'vitest';

describe('ToneService', () => {
  let service: ToneService;

  beforeEach(() => {
    service = new ToneService();
  });

  describe('applyTone', () => {
    it('should return original prompt when no tone is provided', () => {
      const systemPrompt = 'You are a helpful assistant.';

      const result = service.applyTone(undefined, systemPrompt);

      expect(result).toBe(systemPrompt);
    });

    it('should apply tone when tone object is provided', () => {
      const tone: Tone = {
        id: 'professional',
        name: 'Professional',
        description: 'Professional tone',
        voiceRules: 'Use formal language and proper grammar.',
        createdAt: new Date().toISOString(),
        folderId: null,
      };

      const systemPrompt = 'You are a helpful assistant.';

      const result = service.applyTone(tone, systemPrompt);

      expect(result).toContain(systemPrompt);
      expect(result).toContain('# Writing Style');
      expect(result).toContain('Use formal language and proper grammar.');
    });

    it('should apply the specific tone provided', () => {
      const tone: Tone = {
        id: 'professional',
        name: 'Professional',
        description: 'Professional tone',
        voiceRules: 'Use formal language.',
        createdAt: new Date().toISOString(),
        folderId: null,
      };

      const systemPrompt = 'You are a helpful assistant.';

      const result = service.applyTone(tone, systemPrompt);

      expect(result).toContain('Use formal language.');
    });

    it('should return original prompt when tone has no voiceRules', () => {
      const tone: Tone = {
        id: 'empty-tone',
        name: 'Empty Tone',
        description: 'Tone with no rules',
        voiceRules: '', // Empty voice rules
        createdAt: new Date().toISOString(),
        folderId: null,
      };

      const systemPrompt = 'You are a helpful assistant.';

      const result = service.applyTone(tone, systemPrompt);

      expect(result).toBe(systemPrompt);
    });

    it('should include examples in enhanced prompt if provided', () => {
      const tone: Tone = {
        id: 'professional',
        name: 'Professional',
        description: 'Professional tone',
        voiceRules: 'Use formal language.',
        examples: 'Example 1: Dear Sir/Madam',
        createdAt: new Date().toISOString(),
        folderId: null,
      };

      const systemPrompt = 'You are a helpful assistant.';

      const result = service.applyTone(tone, systemPrompt);

      expect(result).toContain('Use formal language.');
      expect(result).toContain('# Writing Style');
    });

    it('should handle tone with special characters in voiceRules', () => {
      const tone: Tone = {
        id: 'technical',
        name: 'Technical',
        description: 'Technical writing',
        voiceRules:
          'Use precise terminology. Include code examples:\n```typescript\nconst x = 1;\n```',
        createdAt: new Date().toISOString(),
        folderId: null,
      };

      const systemPrompt = 'You are a helpful assistant.';

      const result = service.applyTone(tone, systemPrompt);

      expect(result).toContain('Use precise terminology');
      expect(result).toContain('```typescript');
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete tone application workflow', () => {
      const professionalTone: Tone = {
        id: 'professional',
        name: 'Professional',
        description: 'Professional business tone',
        voiceRules: 'Use formal language. Avoid contractions. Be precise.',
        createdAt: new Date().toISOString(),
        folderId: null,
      };

      const systemPrompt =
        'You are an AI assistant that helps with writing tasks.';

      const enhancedPrompt = service.applyTone(professionalTone, systemPrompt);

      expect(enhancedPrompt).toContain(systemPrompt);
      expect(enhancedPrompt).toContain('# Writing Style');
      expect(enhancedPrompt).toContain('Use formal language');
      expect(enhancedPrompt).toContain('Avoid contractions');
    });

    it('should handle switching between different tones', () => {
      const professionalTone: Tone = {
        id: 'professional',
        name: 'Professional',
        description: 'Professional business tone',
        voiceRules: 'Use formal language.',
        createdAt: new Date().toISOString(),
        folderId: null,
      };

      const casualTone: Tone = {
        id: 'casual',
        name: 'Casual',
        description: 'Casual friendly tone',
        voiceRules: 'Be casual and friendly.',
        createdAt: new Date().toISOString(),
        folderId: null,
      };

      const systemPrompt = 'You are a helpful assistant.';

      // Apply professional tone
      let result = service.applyTone(professionalTone, systemPrompt);
      expect(result).toContain('Use formal language.');

      // Switch to casual tone
      result = service.applyTone(casualTone, systemPrompt);
      expect(result).toContain('Be casual and friendly.');
      expect(result).not.toContain('Use formal language.');
    });

    it('should preserve system prompt when tone is null', () => {
      const systemPrompt =
        'You are a helpful assistant with special instructions.';

      const result = service.applyTone(undefined, systemPrompt);

      expect(result).toBe(systemPrompt);
    });
  });
});
