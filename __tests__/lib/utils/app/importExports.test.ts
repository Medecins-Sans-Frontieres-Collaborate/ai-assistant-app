import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
} from '@/lib/utils/app/const';
import {
  cleanData,
  isExportFormatV1,
  isExportFormatV2,
  isExportFormatV3,
  isExportFormatV4,
  isLatestExportFormat,
} from '@/lib/utils/app/export/importExport';

import { ExportFormatV1, ExportFormatV2, ExportFormatV4 } from '@/types/export';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { getDefaultModel } from '@/config/models';
import { describe, expect, it } from 'vitest';

describe('Export Format Functions', () => {
  describe('isExportFormatV1', () => {
    it('should return true for v1 format', () => {
      const obj = [{ id: 1 }];
      expect(isExportFormatV1(obj)).toBe(true);
    });

    it('should return false for non-v1 formats', () => {
      const obj = { version: 3, history: [], folders: [] };
      expect(isExportFormatV1(obj)).toBe(false);
    });
  });

  describe('isExportFormatV2', () => {
    it('should return true for v2 format', () => {
      const obj = { history: [], folders: [] };
      expect(isExportFormatV2(obj)).toBe(true);
    });

    it('should return false for non-v2 formats', () => {
      const obj = { version: 3, history: [], folders: [] };
      expect(isExportFormatV2(obj)).toBe(false);
    });
  });

  describe('isExportFormatV3', () => {
    it('should return true for v3 format', () => {
      const obj = { version: 3, history: [], folders: [] };
      expect(isExportFormatV3(obj)).toBe(true);
    });

    it('should return false for non-v3 formats', () => {
      const obj = { version: 4, history: [], folders: [] };
      expect(isExportFormatV3(obj)).toBe(false);
    });
  });

  describe('isExportFormatV4', () => {
    it('should return true for v4 format', () => {
      const obj = { version: 4, history: [], folders: [], prompts: [] };
      expect(isExportFormatV4(obj)).toBe(true);
    });

    it('should return false for non-v4 formats', () => {
      const obj = { version: 5, history: [], folders: [], prompts: [] };
      expect(isExportFormatV4(obj)).toBe(false);
    });
  });
});

describe('cleanData Functions', () => {
  describe('cleaning v1 data', () => {
    it('should return the latest format', () => {
      const data = [
        {
          id: 1,
          name: 'conversation 1',
          messages: [
            {
              role: 'user',
              content: "what's up ?",
            },
            {
              role: 'assistant',
              content: 'Hi',
            },
          ],
        },
      ] as ExportFormatV1;
      const obj = cleanData(data);
      expect(isLatestExportFormat(obj)).toBe(true);
      expect(obj.version).toBe(5);
      expect(obj.folders).toEqual([]);
      expect(obj.prompts).toEqual([]);
      expect(obj.tones).toEqual([]);
      expect(obj.customAgents).toEqual([]);
      expect(obj.history).toHaveLength(1);
      // Check conversation properties
      const conv = obj.history[0];
      expect(conv.id).toBe(1);
      expect(conv.name).toBe('conversation 1');
      expect(conv.model).toEqual(
        OpenAIModels[getDefaultModel() as OpenAIModelID],
      );
      expect(conv.prompt).toBe(DEFAULT_SYSTEM_PROMPT);
      expect(conv.temperature).toBe(DEFAULT_TEMPERATURE);
      expect(conv.folderId).toBeNull();
      // Messages are migrated: assistant messages become AssistantMessageGroup
      expect(conv.messages).toHaveLength(2);
      expect(conv.messages[0]).toEqual({
        role: 'user',
        content: "what's up ?",
      });
      // Assistant message migrated to AssistantMessageGroup
      const assistantGroup = conv.messages[1] as any;
      expect(assistantGroup.type).toBe('assistant_group');
      expect(assistantGroup.activeIndex).toBe(0);
      expect(assistantGroup.versions[0].content).toBe('Hi');
    });
  });

  describe('cleaning v2 data', () => {
    it('should return the latest format', () => {
      const data = {
        history: [
          {
            id: '1',
            name: 'conversation 1',
            messages: [
              {
                role: 'user',
                content: "what's up ?",
              },
              {
                role: 'assistant',
                content: 'Hi',
              },
            ],
          },
        ],
        folders: [
          {
            id: 1,
            name: 'folder 1',
          },
        ],
      } as ExportFormatV2;
      const obj = cleanData(data);
      expect(isLatestExportFormat(obj)).toBe(true);
      expect(obj.version).toBe(5);
      expect(obj.prompts).toEqual([]);
      expect(obj.tones).toEqual([]);
      expect(obj.customAgents).toEqual([]);
      expect(obj.folders).toEqual([
        {
          id: '1',
          name: 'folder 1',
          type: 'chat',
        },
      ]);
      expect(obj.history).toHaveLength(1);
      // Check conversation properties
      const conv = obj.history[0];
      expect(conv.id).toBe('1');
      expect(conv.name).toBe('conversation 1');
      expect(conv.model).toEqual(
        OpenAIModels[getDefaultModel() as OpenAIModelID],
      );
      expect(conv.prompt).toBe(DEFAULT_SYSTEM_PROMPT);
      expect(conv.temperature).toBe(DEFAULT_TEMPERATURE);
      expect(conv.folderId).toBeNull();
      // Messages are migrated: assistant messages become AssistantMessageGroup
      expect(conv.messages).toHaveLength(2);
      expect(conv.messages[0]).toEqual({
        role: 'user',
        content: "what's up ?",
      });
      // Assistant message migrated to AssistantMessageGroup
      const assistantGroup = conv.messages[1] as any;
      expect(assistantGroup.type).toBe('assistant_group');
      expect(assistantGroup.activeIndex).toBe(0);
      expect(assistantGroup.versions[0].content).toBe('Hi');
    });
  });

  describe('cleaning v4 data', () => {
    it('should return the latest format', () => {
      const data = {
        version: 4,
        history: [
          {
            id: '1',
            name: 'conversation 1',
            messages: [
              {
                role: 'user',
                content: "what's up ?",
              },
              {
                role: 'assistant',
                content: 'Hi',
              },
            ],
            model: OpenAIModels[OpenAIModelID.GPT_5_2],
            prompt: DEFAULT_SYSTEM_PROMPT,
            temperature: DEFAULT_TEMPERATURE,
            folderId: null,
          },
        ],
        folders: [
          {
            id: '1',
            name: 'folder 1',
            type: 'chat',
          },
        ],
        prompts: [
          {
            id: '1',
            name: 'prompt 1',
            description: '',
            content: '',
            model: OpenAIModels[OpenAIModelID.GPT_5_2],
            folderId: null,
          },
        ],
      } as ExportFormatV4;

      const obj = cleanData(data);
      expect(isLatestExportFormat(obj)).toBe(true);
      expect(obj.version).toBe(5);
      expect(obj.tones).toEqual([]);
      expect(obj.customAgents).toEqual([]);
      expect(obj.folders).toEqual([
        {
          id: '1',
          name: 'folder 1',
          type: 'chat',
        },
      ]);
      expect(obj.prompts).toEqual([
        {
          id: '1',
          name: 'prompt 1',
          description: '',
          content: '',
          model: OpenAIModels[OpenAIModelID.GPT_5_2],
          folderId: null,
        },
      ]);
      expect(obj.history).toHaveLength(1);
      // Check conversation properties
      const conv = obj.history[0];
      expect(conv.id).toBe('1');
      expect(conv.name).toBe('conversation 1');
      // v4 format preserves the explicit model from import data
      expect(conv.model).toEqual(OpenAIModels[OpenAIModelID.GPT_5_2]);
      expect(conv.prompt).toBe(DEFAULT_SYSTEM_PROMPT);
      expect(conv.temperature).toBe(DEFAULT_TEMPERATURE);
      expect(conv.folderId).toBeNull();
      // Messages are migrated: assistant messages become AssistantMessageGroup
      expect(conv.messages).toHaveLength(2);
      expect(conv.messages[0]).toEqual({
        role: 'user',
        content: "what's up ?",
      });
      // Assistant message migrated to AssistantMessageGroup
      const assistantGroup = conv.messages[1] as any;
      expect(assistantGroup.type).toBe('assistant_group');
      expect(assistantGroup.activeIndex).toBe(0);
      expect(assistantGroup.versions[0].content).toBe('Hi');
    });

    it('should handle v4 data with missing folders and prompts fields', () => {
      // This simulates production exports that may be missing optional fields
      const data = {
        version: 4,
        history: [
          {
            id: '1',
            name: 'conversation 1',
            messages: [
              {
                role: 'user',
                content: "what's up ?",
              },
              {
                role: 'assistant',
                content: 'Hi',
              },
            ],
            model: OpenAIModels[OpenAIModelID.GPT_5_2],
            prompt: DEFAULT_SYSTEM_PROMPT,
            temperature: DEFAULT_TEMPERATURE,
            folderId: null,
          },
        ],
        // Note: folders and prompts are intentionally missing
      };

      // Should not throw when fields are missing
      const obj = cleanData(data as ExportFormatV4);
      expect(isLatestExportFormat(obj)).toBe(true);
      expect(obj.folders).toEqual([]);
      expect(obj.prompts).toEqual([]);
      expect(obj.tones).toEqual([]);
      expect(obj.customAgents).toEqual([]);
      expect(obj.history).toHaveLength(1);
    });
  });
});
