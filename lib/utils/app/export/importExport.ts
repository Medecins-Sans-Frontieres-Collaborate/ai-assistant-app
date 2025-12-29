import { LocalStorageService } from '@/client/services/storage/localStorageService';

import { Conversation } from '@/types/chat';
import {
  ExportFormatV1,
  ExportFormatV2,
  ExportFormatV3,
  ExportFormatV4,
  ExportFormatV5,
  LatestExportFormat,
  SupportedExportFormats,
} from '@/types/export';
import { FolderInterface } from '@/types/folder';
import { Prompt } from '@/types/prompt';
import { Tone } from '@/types/tone';

import { cleanConversationHistory } from '../clean';

export function isExportFormatV1(obj: any): obj is ExportFormatV1 {
  return Array.isArray(obj);
}

export function isExportFormatV2(obj: any): obj is ExportFormatV2 {
  return !('version' in obj) && 'folders' in obj && 'history' in obj;
}

export function isExportFormatV3(obj: any): obj is ExportFormatV3 {
  return obj.version === 3;
}

export function isExportFormatV4(obj: any): obj is ExportFormatV4 {
  return obj.version === 4;
}

export function isExportFormatV5(obj: any): obj is ExportFormatV5 {
  return obj.version === 5;
}

export const isLatestExportFormat = isExportFormatV5;

export function cleanData(data: SupportedExportFormats): LatestExportFormat {
  if (isExportFormatV1(data)) {
    return {
      version: 5,
      history: cleanConversationHistory(data),
      folders: [],
      prompts: [],
      tones: [],
      customAgents: [],
    };
  }

  if (isExportFormatV2(data)) {
    return {
      version: 5,
      history: cleanConversationHistory(data.history || []),
      folders: (data.folders || []).map((chatFolder) => ({
        id: chatFolder.id.toString(),
        name: chatFolder.name,
        type: 'chat',
      })),
      prompts: [],
      tones: [],
      customAgents: [],
    };
  }

  if (isExportFormatV3(data)) {
    return {
      version: 5,
      history: cleanConversationHistory(data.history || []),
      folders: data.folders || [],
      prompts: [],
      tones: [],
      customAgents: [],
    };
  }

  if (isExportFormatV4(data)) {
    return {
      version: 5,
      history: cleanConversationHistory(data.history || []),
      folders: data.folders || [],
      prompts: data.prompts || [],
      tones: [],
      customAgents: [],
    };
  }

  if (isExportFormatV5(data)) {
    return data;
  }

  throw new Error('Unsupported data format');
}

function currentDate() {
  const date = new Date();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month}-${day}`;
}

export const exportData = () => {
  // Migrate any legacy data to Zustand format first
  LocalStorageService.migrateFromLegacy();

  // Read from Zustand storage keys
  const conversationStorage = localStorage.getItem('conversation-storage');
  const settingsStorage = localStorage.getItem('settings-storage');

  // Extract conversations and folders from conversation-storage
  let historyArray: Conversation[] = [];
  let foldersArray: FolderInterface[] = [];
  if (conversationStorage) {
    const conversationData = JSON.parse(conversationStorage);
    historyArray = conversationData?.state?.conversations || [];
    foldersArray = conversationData?.state?.folders || [];
  }

  // Extract prompts, tones, and customAgents from settings-storage
  let promptsArray: Prompt[] = [];
  let tonesArray: Tone[] = [];
  let customAgentsArray: any[] = [];
  if (settingsStorage) {
    const settingsData = JSON.parse(settingsStorage);
    promptsArray = settingsData?.state?.prompts || [];
    tonesArray = settingsData?.state?.tones || [];
    customAgentsArray = settingsData?.state?.customAgents || [];
  }

  const data = {
    version: 5,
    history: historyArray,
    folders: foldersArray,
    prompts: promptsArray,
    tones: tonesArray,
    customAgents: customAgentsArray,
  } as LatestExportFormat;

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = `chatbot_ui_history_${currentDate()}.json`;
  link.href = url;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export const importData = (
  data: SupportedExportFormats,
): LatestExportFormat => {
  // Migrate any legacy data to Zustand format first
  LocalStorageService.migrateFromLegacy();

  const { history, folders, prompts, tones, customAgents } = cleanData(data);

  // Read existing data from Zustand conversation-storage
  const conversationStorage = localStorage.getItem('conversation-storage');
  const existingConvData = conversationStorage
    ? JSON.parse(conversationStorage)
    : {
        state: { conversations: [], folders: [], selectedConversationId: null },
        version: 1,
      };

  const oldConversationsParsed = existingConvData?.state?.conversations || [];
  const oldFoldersParsed = existingConvData?.state?.folders || [];

  // Merge conversations (dedupe by id)
  const newHistory: Conversation[] = [
    ...oldConversationsParsed,
    ...history,
  ].filter(
    (conversation, index, self) =>
      index === self.findIndex((c) => c.id === conversation.id),
  );

  // Merge folders (dedupe by id)
  const newFolders: FolderInterface[] = [
    ...oldFoldersParsed,
    ...folders,
  ].filter(
    (folder, index, self) =>
      index === self.findIndex((f) => f.id === folder.id),
  );

  // Write to Zustand conversation-storage
  const newConversationData = {
    state: {
      conversations: newHistory,
      folders: newFolders,
      selectedConversationId:
        newHistory.length > 0 ? newHistory[newHistory.length - 1].id : null,
    },
    version: 1,
  };
  localStorage.setItem(
    'conversation-storage',
    JSON.stringify(newConversationData),
  );

  // Read existing data from Zustand settings-storage
  const settingsStorage = localStorage.getItem('settings-storage');
  const settingsData = settingsStorage
    ? JSON.parse(settingsStorage)
    : { state: {}, version: 1 };

  // Merge prompts (dedupe by id)
  const oldPromptsParsed = settingsData?.state?.prompts || [];
  const newPrompts: Prompt[] = [...oldPromptsParsed, ...prompts].filter(
    (prompt, index, self) =>
      index === self.findIndex((p) => p.id === prompt.id),
  );

  // Merge tones (dedupe by id)
  const oldTones = settingsData?.state?.tones || [];
  const newTones: Tone[] = [...oldTones, ...tones].filter(
    (tone, index, self) => index === self.findIndex((t) => t.id === tone.id),
  );

  // Merge custom agents (dedupe by id)
  const oldCustomAgents = settingsData?.state?.customAgents || [];
  const newCustomAgents = [...oldCustomAgents, ...customAgents].filter(
    (agent, index, self) => index === self.findIndex((a) => a.id === agent.id),
  );

  // Write to Zustand settings-storage
  settingsData.state = {
    ...settingsData.state,
    prompts: newPrompts,
    tones: newTones,
    customAgents: newCustomAgents,
  };
  localStorage.setItem('settings-storage', JSON.stringify(settingsData));

  return {
    version: 5,
    history: newHistory,
    folders: newFolders,
    prompts: newPrompts,
    tones: newTones,
    customAgents: newCustomAgents,
  };
};
