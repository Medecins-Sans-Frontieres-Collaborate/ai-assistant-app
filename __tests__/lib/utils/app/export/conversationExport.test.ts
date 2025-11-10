import {
  ConversationExportFormat,
  isValidConversationExport,
  validateAndPrepareImport,
} from '@/lib/utils/app/export/conversationExport';

import { Conversation, MessageType } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { describe, expect, it } from 'vitest';

describe('conversationExport', () => {
  const mockConversation: Conversation = {
    id: 'conv-1',
    name: 'Test Conversation',
    messages: [
      { role: 'user', content: 'Hello', messageType: MessageType.TEXT },
      {
        role: 'assistant',
        content: 'Hi there!',
        messageType: MessageType.TEXT,
      },
    ],
    model: OpenAIModels['gpt-4o' as keyof typeof OpenAIModels],
    prompt: 'You are a helpful assistant',
    temperature: 0.7,
    folderId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  describe('isValidConversationExport', () => {
    it('should validate a correct conversation export', () => {
      const validExport: ConversationExportFormat = {
        version: 1,
        type: 'single-conversation',
        conversation: mockConversation,
        exportedAt: '2024-01-01T00:00:00.000Z',
      };

      expect(isValidConversationExport(validExport)).toBe(true);
    });

    it('should reject null or undefined', () => {
      expect(isValidConversationExport(null)).toBeFalsy();
      expect(isValidConversationExport(undefined)).toBeFalsy();
    });

    it('should reject non-object data', () => {
      expect(isValidConversationExport('string')).toBe(false);
      expect(isValidConversationExport(123)).toBe(false);
      expect(isValidConversationExport(true)).toBe(false);
      expect(isValidConversationExport([])).toBe(false);
    });

    it('should reject missing version', () => {
      const invalid = {
        type: 'single-conversation',
        conversation: mockConversation,
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(invalid)).toBe(false);
    });

    it('should reject wrong version', () => {
      const invalid = {
        version: 2,
        type: 'single-conversation',
        conversation: mockConversation,
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(invalid)).toBe(false);
    });

    it('should reject wrong type', () => {
      const invalid = {
        version: 1,
        type: 'folder-export',
        conversation: mockConversation,
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(invalid)).toBe(false);
    });

    it('should reject missing conversation', () => {
      const invalid = {
        version: 1,
        type: 'single-conversation',
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(invalid)).toBeFalsy();
    });

    it('should reject non-object conversation', () => {
      const invalid = {
        version: 1,
        type: 'single-conversation',
        conversation: 'not an object',
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(invalid)).toBe(false);
    });

    it('should reject conversation missing id', () => {
      const invalid = {
        version: 1,
        type: 'single-conversation',
        conversation: {
          name: 'Test',
          messages: [],
        },
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(invalid)).toBe(false);
    });

    it('should reject conversation with non-string id', () => {
      const invalid = {
        version: 1,
        type: 'single-conversation',
        conversation: {
          id: 123,
          name: 'Test',
          messages: [],
        },
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(invalid)).toBe(false);
    });

    it('should reject conversation missing name', () => {
      const invalid = {
        version: 1,
        type: 'single-conversation',
        conversation: {
          id: 'conv-1',
          messages: [],
        },
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(invalid)).toBe(false);
    });

    it('should reject conversation with non-string name', () => {
      const invalid = {
        version: 1,
        type: 'single-conversation',
        conversation: {
          id: 'conv-1',
          name: 123,
          messages: [],
        },
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(invalid)).toBe(false);
    });

    it('should reject conversation with non-array messages', () => {
      const invalid = {
        version: 1,
        type: 'single-conversation',
        conversation: {
          id: 'conv-1',
          name: 'Test',
          messages: 'not an array',
        },
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(invalid)).toBe(false);
    });

    it('should accept conversation with empty messages array', () => {
      const valid = {
        version: 1,
        type: 'single-conversation',
        conversation: {
          id: 'conv-1',
          name: 'Empty Conversation',
          messages: [],
        },
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidConversationExport(valid)).toBe(true);
    });
  });

  describe('validateAndPrepareImport', () => {
    const validExport: ConversationExportFormat = {
      version: 1,
      type: 'single-conversation',
      conversation: mockConversation,
      exportedAt: '2024-01-01T00:00:00.000Z',
    };

    it('should validate and accept valid conversation with no conflicts', () => {
      const result = validateAndPrepareImport(validExport, []);

      expect(result.isValid).toBe(true);
      expect(result.conversation).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.conversation?.id).toBe('conv-1');
      expect(result.conversation?.name).toBe('Test Conversation');
    });

    it('should add timestamps if missing', () => {
      const conversationWithoutTimestamps: Conversation = {
        ...mockConversation,
        createdAt: undefined as any,
        updatedAt: undefined as any,
      };

      const exportData: ConversationExportFormat = {
        version: 1,
        type: 'single-conversation',
        conversation: conversationWithoutTimestamps,
        exportedAt: '2024-01-01T00:00:00.000Z',
      };

      const result = validateAndPrepareImport(exportData, []);

      expect(result.isValid).toBe(true);
      expect(result.conversation?.createdAt).toBeDefined();
      expect(result.conversation?.updatedAt).toBeDefined();
      expect(typeof result.conversation?.createdAt).toBe('string');
      expect(typeof result.conversation?.updatedAt).toBe('string');
    });

    it('should preserve existing timestamps', () => {
      const result = validateAndPrepareImport(validExport, []);

      expect(result.conversation?.createdAt).toBe('2024-01-01T00:00:00.000Z');
      expect(result.conversation?.updatedAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should regenerate ID and update name when ID conflict exists', () => {
      const existingConversations: Conversation[] = [mockConversation];

      const result = validateAndPrepareImport(
        validExport,
        existingConversations,
      );

      expect(result.isValid).toBe(true);
      expect(result.conversation?.id).not.toBe('conv-1');
      expect(result.conversation?.id).toContain('conversation-');
      expect(result.conversation?.name).toBe('Test Conversation (imported)');
    });

    it('should generate unique ID on conflict', () => {
      const existingConversations: Conversation[] = [mockConversation];

      const result1 = validateAndPrepareImport(
        validExport,
        existingConversations,
      );
      const result2 = validateAndPrepareImport(
        validExport,
        existingConversations,
      );

      expect(result1.conversation?.id).not.toBe(result2.conversation?.id);
    });

    it('should update timestamps when regenerating ID', () => {
      const existingConversations: Conversation[] = [mockConversation];
      const beforeImport = new Date().toISOString();

      const result = validateAndPrepareImport(
        validExport,
        existingConversations,
      );

      expect(result.conversation?.createdAt).toBeDefined();
      expect(result.conversation?.updatedAt).toBeDefined();
      // Timestamps should be recent
      expect(result.conversation?.createdAt).toBeTruthy();
      expect(result.conversation!.createdAt! >= beforeImport).toBe(true);
      expect(result.conversation!.updatedAt! >= beforeImport).toBe(true);
    });

    it('should reject invalid format', () => {
      const invalidData = {
        version: 2,
        type: 'wrong-type',
        conversation: {},
      };

      const result = validateAndPrepareImport(invalidData, []);

      expect(result.isValid).toBe(false);
      expect(result.conversation).toBeUndefined();
      expect(result.error).toBe(
        'Invalid conversation file format. Please select a valid conversation export file.',
      );
    });

    it('should reject null data', () => {
      const result = validateAndPrepareImport(null, []);

      expect(result.isValid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject undefined data', () => {
      const result = validateAndPrepareImport(undefined, []);

      expect(result.isValid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle empty existing conversations array', () => {
      const result = validateAndPrepareImport(validExport, []);

      expect(result.isValid).toBe(true);
      expect(result.conversation?.id).toBe(mockConversation.id);
    });

    it('should preserve all conversation properties', () => {
      const result = validateAndPrepareImport(validExport, []);

      expect(result.conversation?.model).toEqual(mockConversation.model);
      expect(result.conversation?.prompt).toBe(mockConversation.prompt);
      expect(result.conversation?.temperature).toBe(
        mockConversation.temperature,
      );
      expect(result.conversation?.folderId).toBe(mockConversation.folderId);
      expect(result.conversation?.messages).toEqual(mockConversation.messages);
    });

    it('should handle conversation with folderId', () => {
      const conversationWithFolder: Conversation = {
        ...mockConversation,
        folderId: 'folder-123',
      };

      const exportData: ConversationExportFormat = {
        version: 1,
        type: 'single-conversation',
        conversation: conversationWithFolder,
        exportedAt: '2024-01-01T00:00:00.000Z',
      };

      const result = validateAndPrepareImport(exportData, []);

      expect(result.isValid).toBe(true);
      expect(result.conversation?.folderId).toBe('folder-123');
    });

    it('should handle multiple conflicts in existing conversations', () => {
      const existingConversations: Conversation[] = [
        mockConversation,
        { ...mockConversation, id: 'conv-2', name: 'Other' },
        { ...mockConversation, id: 'conv-3', name: 'Another' },
      ];

      const result = validateAndPrepareImport(
        validExport,
        existingConversations,
      );

      expect(result.isValid).toBe(true);
      expect(result.conversation?.id).not.toBe('conv-1');
      expect(result.conversation?.name).toBe('Test Conversation (imported)');
    });

    it('should handle conversation with complex messages', () => {
      const complexConversation: Conversation = {
        ...mockConversation,
        messages: [
          { role: 'user', content: 'Hello', messageType: MessageType.TEXT },
          { role: 'assistant', content: 'Hi!', messageType: MessageType.TEXT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Check this image' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,...', detail: 'auto' },
              },
            ],
            messageType: MessageType.IMAGE as any,
          },
        ],
      };

      const exportData: ConversationExportFormat = {
        version: 1,
        type: 'single-conversation',
        conversation: complexConversation,
        exportedAt: '2024-01-01T00:00:00.000Z',
      };

      const result = validateAndPrepareImport(exportData, []);

      expect(result.isValid).toBe(true);
      expect(result.conversation?.messages).toEqual(
        complexConversation.messages,
      );
    });
  });
});
