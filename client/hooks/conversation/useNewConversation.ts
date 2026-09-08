'use client';

import { useCallback } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useModelAvailability } from '@/client/hooks/settings/useMyLimits';
import { useSettings } from '@/client/hooks/settings/useSettings';

import { isLocalModel } from '@/lib/services/models/localModels';

import { isAgentShapedModelId } from '@/lib/utils/app/agentAttachment';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { getOrganizationAgentIdFromModelId } from '@/lib/organizationAgents';
import { v4 as uuidv4 } from 'uuid';

/**
 * True for a model that is supposed to be in `settingsStore.models` — the
 * server-served catalog list — as opposed to one the client resolves on
 * its own: agents (org-/foundry-/custom-), custom-source (byom) models and
 * local runtimes are never in that list, so their absence means nothing.
 * Mirrors the pass-through checks in chatStore.sendChatRequest.
 */
export function isServedCatalogModel(
  model: Pick<
    OpenAIModel,
    | 'id'
    | 'isOrganizationAgent'
    | 'isCustomAgent'
    | 'isCustomSourceModel'
    | 'isLocalModel'
  >,
): boolean {
  return !(
    isAgentShapedModelId(model.id) ||
    model.isOrganizationAgent === true ||
    model.isCustomAgent === true ||
    model.id.startsWith('byom-') ||
    model.isCustomSourceModel === true ||
    isLocalModel(model)
  );
}

/**
 * "New chat" as a reusable action. Returns `startNewConversation(folderId?)`,
 * shared by the sidebar (button, ⌘N, folder menu) and the folder view so
 * every entry point creates chats the same way: the latest still-empty chat
 * is reused (moved into `folderId` when asked) instead of orphaning it, the
 * current conversation's model carries over — unless the server no longer
 * serves it or the user's budget for it is used up, in which case the
 * settings default (then the first served model) is used so a blocked
 * model does not propagate from chat to chat — and agent/search defaults
 * are derived from the chosen model.
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
  // Fail-open by construction: 'available' whenever the limits flag is off,
  // the policy is in observe mode, or the id is not in the limits payload.
  const currentModelAvailability = useModelAvailability(
    selectedConversation?.model?.id,
  );

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

      // Carry the current model over as-is (preserves custom agents, byom
      // and local models, which are never in the served list). A served
      // catalog model only carries over while it is still served (a model
      // the server hid — e.g. blocked by an admin limit — must not follow
      // the user into the next chat) and not exhausted for this user.
      const canCarryOver =
        !!currentModel &&
        (!isServedCatalogModel(currentModel) ||
          (models.some((m) => m.id === currentModel.id) &&
            currentModelAvailability.state === 'available'));
      const modelToUse = canCarryOver
        ? currentModel
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
      currentModelAvailability.state,
    ],
  );
}
