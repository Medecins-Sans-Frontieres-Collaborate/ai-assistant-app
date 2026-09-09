import { useCallback, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useSettings } from '@/client/hooks/settings/useSettings';

import { detectForeignExport } from '@/lib/utils/app/export/foreignImport/detect';
import { foreignToConversation } from '@/lib/utils/app/export/foreignImport/toConversation';
import {
  ForeignConversation,
  ForeignImportDetection,
  ForeignSource,
} from '@/lib/utils/app/export/foreignImport/types';

import { Conversation } from '@/types/chat';

import { v4 as uuidv4 } from 'uuid';

export interface ForeignImportCommitOptions {
  /** Create a folder with this name and place every import in it. */
  folderName: string | null;
}

/**
 * State + commit logic for importing ChatGPT / Claude exports, shared by the
 * sidebar "Import conversation" input and the settings "Import Backup"
 * button. `offer(data)` returns true when the parsed JSON is a recognised
 * foreign export (and opens the picker); the caller falls through to its own
 * formats otherwise.
 */
export function useForeignConversationImport() {
  const t = useTranslations('conversationImport');
  const { conversations, setConversations, selectConversation, addFolder } =
    useConversations();
  const { defaultModelId, models, temperature, systemPrompt } = useSettings();
  const [pending, setPending] = useState<ForeignImportDetection | null>(null);

  const existingIds = useMemo(
    () => new Set(conversations.map((c) => c.id)),
    [conversations],
  );

  const sourceLabel = useCallback(
    (source: ForeignSource) =>
      source === 'chatgpt' ? t('sourceChatGpt') : t('sourceClaude'),
    [t],
  );

  const offer = useCallback(
    (data: unknown): boolean => {
      const detection = detectForeignExport(data);
      if (!detection) return false;
      if (detection.conversations.length === 0) {
        toast.error(
          t('nothingImportable', { source: sourceLabel(detection.source) }),
        );
        return true;
      }
      setPending(detection);
      return true;
    },
    [sourceLabel, t],
  );

  const close = useCallback(() => setPending(null), []);

  const commit = useCallback(
    (selected: ForeignConversation[], options: ForeignImportCommitOptions) => {
      const model = models.find((m) => m.id === defaultModelId) ?? models[0];
      if (!model) {
        toast.error(t('noModel'));
        return;
      }

      let folderId: string | null = null;
      if (options.folderName && options.folderName.trim()) {
        const folder = {
          id: uuidv4(),
          name: options.folderName.trim(),
          type: 'chat' as const,
        };
        addFolder(folder);
        folderId = folder.id;
      }

      const untitled = t('untitled');
      const imported: Conversation[] = selected.map((foreign) => {
        const conversation = foreignToConversation(
          foreign,
          { model, prompt: systemPrompt, temperature, folderId },
          untitled,
        );
        if (!existingIds.has(conversation.id)) return conversation;
        // The user explicitly re-selected something already present: keep
        // both, matching the single-conversation import's collision policy.
        return {
          ...conversation,
          id: `${conversation.id}-${uuidv4().slice(0, 8)}`,
          name: `${conversation.name} (imported)`,
        };
      });

      if (imported.length === 0) {
        setPending(null);
        return;
      }

      // One store write for the whole batch: `addConversation` per item would
      // persist (and re-render the sidebar) once per conversation.
      setConversations([...imported, ...conversations]);
      selectConversation(imported[0].id);
      toast.success(t('success', { count: imported.length }));
      setPending(null);
    },
    [
      addFolder,
      conversations,
      defaultModelId,
      existingIds,
      models,
      selectConversation,
      setConversations,
      systemPrompt,
      t,
      temperature,
    ],
  );

  return { pending, existingIds, offer, close, commit, sourceLabel };
}
