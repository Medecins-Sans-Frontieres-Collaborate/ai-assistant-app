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

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

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
    return {
      ...data,
      history: cleanConversationHistory(data.history || []),
    };
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

  // Read from Zustand stores directly (works with both v4 blob and v5 per-conversation keys)
  const conversationState = useConversationStore.getState();
  const historyArray: Conversation[] = conversationState.conversations || [];
  const foldersArray: FolderInterface[] = conversationState.folders || [];

  const settingsState = useSettingsStore.getState();
  const promptsArray: Prompt[] = settingsState.prompts || [];
  const tonesArray: Tone[] = settingsState.tones || [];
  const customAgentsArray = settingsState.customAgents || [];

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

  // Read existing data from Zustand store (works with v5 per-conversation keys)
  const conversationState = useConversationStore.getState();
  const oldConversationsParsed = conversationState.conversations || [];
  const oldFoldersParsed = conversationState.folders || [];

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

  // Update Zustand store (auto-persists via v5 per-conversation storage adapter)
  conversationState.setConversations(newHistory);
  conversationState.setFolders(newFolders);
  if (newHistory.length > 0) {
    conversationState.selectConversation(newHistory[newHistory.length - 1].id);
  }

  // Read existing data from Zustand settings store
  const settingsState = useSettingsStore.getState();

  // Merge prompts (dedupe by id)
  const oldPromptsParsed = settingsState.prompts || [];
  const newPrompts: Prompt[] = [...oldPromptsParsed, ...prompts].filter(
    (prompt, index, self) =>
      index === self.findIndex((p) => p.id === prompt.id),
  );

  // Merge tones (dedupe by id)
  const oldTones = settingsState.tones || [];
  const newTones: Tone[] = [...oldTones, ...tones].filter(
    (tone, index, self) => index === self.findIndex((t) => t.id === tone.id),
  );

  // Merge custom agents (dedupe by id)
  const oldCustomAgents = settingsState.customAgents || [];
  const newCustomAgents = [...oldCustomAgents, ...customAgents].filter(
    (agent, index, self) => index === self.findIndex((a) => a.id === agent.id),
  );

  // Update Zustand settings store (auto-persists)
  settingsState.setPrompts(newPrompts);
  settingsState.setTones(newTones);
  settingsState.setCustomAgents(newCustomAgents);

  return {
    version: 5,
    history: newHistory,
    folders: newFolders,
    prompts: newPrompts,
    tones: newTones,
    customAgents: newCustomAgents,
  };
};
