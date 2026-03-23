import {
  tryParseJSON,
  validateConversation,
  validateFolder,
} from '@/lib/utils/app/storage/conversationValidator';

import { describe, expect, it } from 'vitest';

describe('conversationValidator', () => {
  describe('tryParseJSON', () => {
    it('parses valid JSON', () => {
      const result = tryParseJSON('{"key": "value"}');
      expect(result.data).toEqual({ key: 'value' });
      expect(result.error).toBeUndefined();
    });

    it('returns error for invalid JSON', () => {
      const result = tryParseJSON('{invalid}');
      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
    });

    it('handles empty string', () => {
      const result = tryParseJSON('');
      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
    });
  });

  describe('validateConversation', () => {
    const validConversation = {
      id: 'test-id',
      name: 'Test Conversation',
      messages: [],
      model: { id: 'gpt-4', name: 'GPT-4' },
      temperature: 0.7,
      prompt: 'You are a helpful assistant',
      folderId: null,
    };

    it('validates a valid conversation', () => {
      const result = validateConversation(validConversation);
      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.errors).toHaveLength(0);
    });

    it('tolerates extra fields', () => {
      const result = validateConversation({
        ...validConversation,
        createdAt: '2024-01-01',
        customField: 'whatever',
      });
      expect(result.valid).toBe(true);
    });

    it('fails for null input', () => {
      const result = validateConversation(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Not an object');
    });

    it('fails for non-object input', () => {
      const result = validateConversation('string');
      expect(result.valid).toBe(false);
    });

    it('fails for missing id', () => {
      const { id, ...noId } = validConversation;
      const result = validateConversation(noId);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('"id"'))).toBe(true);
    });

    it('fails for empty id', () => {
      const result = validateConversation({ ...validConversation, id: '' });
      expect(result.valid).toBe(false);
    });

    it('fails for missing name', () => {
      const { name, ...noName } = validConversation;
      const result = validateConversation(noName);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('"name"'))).toBe(true);
    });

    it('fails for non-array messages', () => {
      const result = validateConversation({
        ...validConversation,
        messages: 'not an array',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('"messages"'))).toBe(true);
    });

    it('fails for invalid model', () => {
      const result = validateConversation({
        ...validConversation,
        model: 'just-a-string',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('"model"'))).toBe(true);
    });

    it('fails for invalid temperature', () => {
      const result = validateConversation({
        ...validConversation,
        temperature: 'hot',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('"temperature"'))).toBe(true);
    });

    it('reports multiple errors at once', () => {
      const result = validateConversation({});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  describe('validateFolder', () => {
    it('validates a valid folder', () => {
      const result = validateFolder({
        id: 'folder-1',
        name: 'My Folder',
        type: 'chat',
      });
      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('fails for missing id', () => {
      const result = validateFolder({ name: 'Folder', type: 'chat' });
      expect(result.valid).toBe(false);
    });

    it('fails for missing name', () => {
      const result = validateFolder({ id: 'f1', type: 'chat' });
      expect(result.valid).toBe(false);
    });

    it('fails for missing type', () => {
      const result = validateFolder({ id: 'f1', name: 'Folder' });
      expect(result.valid).toBe(false);
    });

    it('fails for null input', () => {
      const result = validateFolder(null);
      expect(result.valid).toBe(false);
    });
  });
});
