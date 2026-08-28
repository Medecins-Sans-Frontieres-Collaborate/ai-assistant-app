'use client';

import { useCallback } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useSettings } from '@/client/hooks/settings/useSettings';

import { Conversation } from '@/types/chat';
import { SearchMode } from '@/types/searchMode';

import { getOrganizationAgentIdFromModelId } from '@/lib/organizationAgents';
import { v4 as uuidv4 } from 'uuid';

/**
 * "New chat" as a reusable action. Returns `startNewConversation(folderId?)`,
 * shared by the sidebar (button, ⌘N, folder menu) and the folder view so
 * every entry point creates chats the same way: the latest still-empty chat
 * is reused (moved into `folderId` when asked) instead of orphaning it, the
 * current conversation's model carries over, and agent/search defaults are
 * derived from the chosen model.
 */
export function useNewConversation(): (folderId?: string | null) => void {
  const t = useTranslations();
  const {
    conversations,
    selectedConversation,
    selectConversation,
    addConversation,
    updateConversation,
  } = useConversations();
  const {
    defaultModelId,
    models,
    temperature,
    systemPrompt,
    defaultSearchMode,
    defaultInterpreterMode,
  } = useSettings();

  return useCallback(
    (folderId: string | null = null) => {
      // Check if the latest conversation is already empty (workflow
      // conversations don't count — reusing one would open its workflow
      // window instead of a fresh chat)
      const latestConversation = conversations[0];
      if (
        latestConversation &&
        latestConversation.messages.length === 0 &&
        !latestConversation.conversationType
      ) {
        const alreadyInFolder =
          (latestConversation.folderId ?? null) === folderId;
        if (!alreadyInFolder) {
          // Reuse the empty conversation rather than leaving an orphan behind;
          // just move it to where the user asked for the new chat.
          updateConversation(latestConversation.id, { folderId });
        }
        if (latestConversation.id !== selectedConversation?.id) {
          // Switch to the existing empty conversation
          selectConversation(latestConversation.id);
        } else if (alreadyInFolder) {
          // Already on the empty conversation - show toast
          toast(t('This conversation is already empty'));
        }
        return;
      }

      // Get the most recently selected model from the current conversation if available,
      // otherwise fall back to the default model from settings
      const currentModel = selectedConversation?.model;

      // Use current conversation's model directly if it exists (preserves custom agents),
      // otherwise look up the default model from settings
      const modelToUse = currentModel
        ? currentModel // Use current model directly (includes custom agents)
        : models.find((m) => m.id === defaultModelId);

      const defaultModel = modelToUse || models[0];
      if (!defaultModel) return;

      // Use the model as-is (preserves all properties including custom agent fields)
      const modelWithDefaults = {
        ...defaultModel,
      };

      // Determine appropriate search mode based on model capabilities
      // If the model is an agent (has agentId), use the default search mode from settings
      // Otherwise, ensure we don't use AGENT mode on non-agent models
      let searchMode = defaultSearchMode;
      if (searchMode === SearchMode.AGENT && !defaultModel.agentId) {
        // Auto-fix: If default is AGENT but model doesn't support it, use INTELLIGENT instead
        searchMode = SearchMode.INTELLIGENT;
      }

      // Get bot ID for organization agents (enables RAG)
      const botId = getOrganizationAgentIdFromModelId(defaultModel.id);

      const newConversation: Conversation = {
        id: uuidv4(),
        name: '',
        messages: [],
        model: modelWithDefaults,
        prompt: systemPrompt || '',
        temperature: temperature || 0.5,
        folderId,
        defaultSearchMode: searchMode, // Use model-appropriate search mode
        defaultInterpreterMode, // Settings default (INTELLIGENT unless the user turned it off)
        bot: botId || undefined, // Set bot ID for RAG-enabled organization agents
      };

      addConversation(newConversation);
      selectConversation(newConversation.id);
    },
    [
      t,
      conversations,
      selectedConversation,
      selectConversation,
      addConversation,
      updateConversation,
      defaultModelId,
      models,
      temperature,
      systemPrompt,
      defaultSearchMode,
      defaultInterpreterMode,
    ],
  );
}
