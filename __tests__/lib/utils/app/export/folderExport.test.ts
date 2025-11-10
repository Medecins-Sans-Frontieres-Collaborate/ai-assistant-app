import {
  FolderExportFormat,
  isValidFolderExport,
  validateAndPrepareFolderImport,
} from '@/lib/utils/app/export/folderExport';

import { Conversation, MessageType } from '@/types/chat';
import { FolderInterface } from '@/types/folder';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { describe, expect, it } from 'vitest';

describe('folderExport', () => {
  const mockFolder: FolderInterface = {
    id: 'folder-1',
    name: 'Work Projects',
    type: 'chat',
  };

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
    folderId: 'folder-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  describe('isValidFolderExport', () => {
    it('should validate a correct folder export', () => {
      const validExport: FolderExportFormat = {
        version: 1,
        type: 'folder-with-conversations',
        folder: mockFolder,
        conversations: [mockConversation],
        exportedAt: '2024-01-01T00:00:00.000Z',
      };

      expect(isValidFolderExport(validExport)).toBe(true);
    });

    it('should accept folder with empty conversations array', () => {
      const validExport: FolderExportFormat = {
        version: 1,
        type: 'folder-with-conversations',
        folder: mockFolder,
        conversations: [],
        exportedAt: '2024-01-01T00:00:00.000Z',
      };

      expect(isValidFolderExport(validExport)).toBe(true);
    });

    it('should reject null or undefined', () => {
      expect(isValidFolderExport(null)).toBeFalsy();
      expect(isValidFolderExport(undefined)).toBeFalsy();
    });

    it('should reject non-object data', () => {
      expect(isValidFolderExport('string')).toBe(false);
      expect(isValidFolderExport(123)).toBe(false);
      expect(isValidFolderExport([])).toBe(false);
    });

    it('should reject wrong version', () => {
      const invalid = {
        version: 2,
        type: 'folder-with-conversations',
        folder: mockFolder,
        conversations: [],
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidFolderExport(invalid)).toBe(false);
    });

    it('should reject wrong type', () => {
      const invalid = {
        version: 1,
        type: 'single-conversation',
        folder: mockFolder,
        conversations: [],
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidFolderExport(invalid)).toBe(false);
    });

    it('should reject missing folder', () => {
      const invalid = {
        version: 1,
        type: 'folder-with-conversations',
        conversations: [],
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidFolderExport(invalid)).toBeFalsy();
    });

    it('should reject non-object folder', () => {
      const invalid = {
        version: 1,
        type: 'folder-with-conversations',
        folder: 'not an object',
        conversations: [],
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidFolderExport(invalid)).toBe(false);
    });

    it('should reject folder missing id', () => {
      const invalid = {
        version: 1,
        type: 'folder-with-conversations',
        folder: { name: 'Test', type: 'chat' },
        conversations: [],
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidFolderExport(invalid)).toBe(false);
    });

    it('should reject folder with non-string id', () => {
      const invalid = {
        version: 1,
        type: 'folder-with-conversations',
        folder: { id: 123, name: 'Test', type: 'chat' },
        conversations: [],
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidFolderExport(invalid)).toBe(false);
    });

    it('should reject folder missing name', () => {
      const invalid = {
        version: 1,
        type: 'folder-with-conversations',
        folder: { id: 'folder-1', type: 'chat' },
        conversations: [],
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidFolderExport(invalid)).toBe(false);
    });

    it('should reject non-array conversations', () => {
      const invalid = {
        version: 1,
        type: 'folder-with-conversations',
        folder: mockFolder,
        conversations: 'not an array',
        exportedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(isValidFolderExport(invalid)).toBe(false);
    });
  });

  describe('validateAndPrepareFolderImport', () => {
    const validExport: FolderExportFormat = {
      version: 1,
      type: 'folder-with-conversations',
      folder: mockFolder,
      conversations: [mockConversation],
      exportedAt: '2024-01-01T00:00:00.000Z',
    };

    it('should validate and accept valid folder with no conflicts', () => {
      const result = validateAndPrepareFolderImport(validExport, [], []);

      expect(result.isValid).toBe(true);
      expect(result.folder).toBeDefined();
      expect(result.conversations).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.folder?.id).toBe('folder-1');
      expect(result.folder?.name).toBe('Work Projects');
      expect(result.conversations).toHaveLength(1);
    });

    it('should regenerate folder ID and update name on conflict', () => {
      const existingFolders: FolderInterface[] = [mockFolder];

      const result = validateAndPrepareFolderImport(
        validExport,
        existingFolders,
        [],
      );

      expect(result.isValid).toBe(true);
      expect(result.folder?.id).not.toBe('folder-1');
      expect(result.folder?.id).toContain('folder-');
      expect(result.folder?.name).toBe('Work Projects (imported)');
    });

    it('should update all conversations to reference new folder ID', () => {
      const existingFolders: FolderInterface[] = [mockFolder];

      const result = validateAndPrepareFolderImport(
        validExport,
        existingFolders,
        [],
      );

      expect(result.conversations?.[0].folderId).toBe(result.folder?.id);
      expect(result.conversations?.[0].folderId).not.toBe('folder-1');
    });

    it('should regenerate conversation IDs on conflict', () => {
      const existingConversations: Conversation[] = [mockConversation];

      const result = validateAndPrepareFolderImport(
        validExport,
        [],
        existingConversations,
      );

      expect(result.isValid).toBe(true);
      expect(result.conversations?.[0].id).not.toBe('conv-1');
      expect(result.conversations?.[0].id).toContain('conversation-');
      expect(result.conversations?.[0].name).toBe(
        'Test Conversation (imported)',
      );
    });

    it('should handle both folder and conversation ID conflicts', () => {
      const existingFolders: FolderInterface[] = [mockFolder];
      const existingConversations: Conversation[] = [mockConversation];

      const result = validateAndPrepareFolderImport(
        validExport,
        existingFolders,
        existingConversations,
      );

      expect(result.isValid).toBe(true);
      expect(result.folder?.id).not.toBe('folder-1');
      expect(result.folder?.name).toBe('Work Projects (imported)');
      expect(result.conversations?.[0].id).not.toBe('conv-1');
      expect(result.conversations?.[0].name).toBe(
        'Test Conversation (imported)',
      );
      expect(result.conversations?.[0].folderId).toBe(result.folder?.id);
    });

    it('should add timestamps to conversations', () => {
      const conversationWithoutUpdatedAt: Conversation = {
        ...mockConversation,
        updatedAt: undefined as any,
      };

      const exportData: FolderExportFormat = {
        ...validExport,
        conversations: [conversationWithoutUpdatedAt],
      };

      const result = validateAndPrepareFolderImport(exportData, [], []);

      expect(result.conversations?.[0].createdAt).toBeDefined();
      expect(result.conversations?.[0].updatedAt).toBeDefined();
    });

    it('should preserve createdAt if present', () => {
      const result = validateAndPrepareFolderImport(validExport, [], []);

      expect(result.conversations?.[0].createdAt).toBe(
        '2024-01-01T00:00:00.000Z',
      );
    });

    it('should always update updatedAt timestamp', () => {
      const beforeImport = new Date().toISOString();
      const result = validateAndPrepareFolderImport(validExport, [], []);

      expect(result.conversations?.[0].updatedAt).toBeDefined();
      expect(result.conversations![0].updatedAt! >= beforeImport).toBe(true);
    });

    it('should handle empty conversations array', () => {
      const exportData: FolderExportFormat = {
        ...validExport,
        conversations: [],
      };

      const result = validateAndPrepareFolderImport(exportData, [], []);

      expect(result.isValid).toBe(true);
      expect(result.folder).toBeDefined();
      expect(result.conversations).toEqual([]);
    });

    it('should handle multiple conversations', () => {
      const conv2: Conversation = {
        ...mockConversation,
        id: 'conv-2',
        name: 'Second Conversation',
      };
      const conv3: Conversation = {
        ...mockConversation,
        id: 'conv-3',
        name: 'Third Conversation',
      };

      const exportData: FolderExportFormat = {
        ...validExport,
        conversations: [mockConversation, conv2, conv3],
      };

      const result = validateAndPrepareFolderImport(exportData, [], []);

      expect(result.isValid).toBe(true);
      expect(result.conversations).toHaveLength(3);
      expect(result.conversations?.[0].name).toBe('Test Conversation');
      expect(result.conversations?.[1].name).toBe('Second Conversation');
      expect(result.conversations?.[2].name).toBe('Third Conversation');
    });

    it('should assign all conversations to new folder ID', () => {
      const conv2: Conversation = {
        ...mockConversation,
        id: 'conv-2',
        name: 'Second',
      };

      const exportData: FolderExportFormat = {
        ...validExport,
        conversations: [mockConversation, conv2],
      };

      const existingFolders: FolderInterface[] = [mockFolder];
      const result = validateAndPrepareFolderImport(
        exportData,
        existingFolders,
        [],
      );

      const newFolderId = result.folder?.id;
      expect(result.conversations?.[0].folderId).toBe(newFolderId);
      expect(result.conversations?.[1].folderId).toBe(newFolderId);
    });

    it('should reject invalid format', () => {
      const invalidData = {
        version: 2,
        type: 'wrong-type',
        folder: {},
        conversations: [],
      };

      const result = validateAndPrepareFolderImport(invalidData, [], []);

      expect(result.isValid).toBe(false);
      expect(result.folder).toBeUndefined();
      expect(result.conversations).toBeUndefined();
      expect(result.error).toBe(
        'Invalid folder file format. Please select a valid folder export file.',
      );
    });

    it('should reject null data', () => {
      const result = validateAndPrepareFolderImport(null, [], []);

      expect(result.isValid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should preserve folder type', () => {
      const result = validateAndPrepareFolderImport(validExport, [], []);

      expect(result.folder?.type).toBe('chat');
    });

    it('should handle selective conversation conflicts', () => {
      const conv2: Conversation = {
        ...mockConversation,
        id: 'conv-2',
        name: 'Unique Conversation',
      };

      const exportData: FolderExportFormat = {
        ...validExport,
        conversations: [mockConversation, conv2],
      };

      // Only conv-1 exists
      const existingConversations: Conversation[] = [mockConversation];

      const result = validateAndPrepareFolderImport(
        exportData,
        [],
        existingConversations,
      );

      expect(result.isValid).toBe(true);
      expect(result.conversations?.[0].id).not.toBe('conv-1'); // Conflicted
      expect(result.conversations?.[1].id).toBe('conv-2'); // No conflict
      expect(result.conversations?.[0].name).toBe(
        'Test Conversation (imported)',
      );
      expect(result.conversations?.[1].name).toBe('Unique Conversation');
    });

    it('should generate unique IDs for each conflict', () => {
      const exportData: FolderExportFormat = {
        ...validExport,
        conversations: [mockConversation],
      };

      const existingConversations: Conversation[] = [mockConversation];

      const result1 = validateAndPrepareFolderImport(
        exportData,
        [],
        existingConversations,
      );
      const result2 = validateAndPrepareFolderImport(
        exportData,
        [],
        existingConversations,
      );

      expect(result1.conversations?.[0].id).not.toBe(
        result2.conversations?.[0].id,
      );
    });

    it('should preserve conversation properties', () => {
      const result = validateAndPrepareFolderImport(validExport, [], []);

      const conv = result.conversations?.[0];
      expect(conv?.model).toEqual(mockConversation.model);
      expect(conv?.prompt).toBe(mockConversation.prompt);
      expect(conv?.temperature).toBe(mockConversation.temperature);
      expect(conv?.messages).toEqual(mockConversation.messages);
    });
  });
});
