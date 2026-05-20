'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';
import { useEffect, useRef } from 'react';

import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { getDefaultModel, isModelDisabled } from '@/config/models';

/**
 * AppInitializer - Handles app initialization logic
 *
 * With Zustand persist middleware, localStorage hydration is automatic.
 * This component handles:
 * 1. Model filtering (based on environment config and feature flags)
 * 2. Default model selection (from environment if not persisted)
 * 3. Selected conversation validation
 *
 * Note: Data migration from legacy localStorage is handled by MigrationDialog
 * in ChatShell.tsx to provide user feedback during the migration process.
 */
export function AppInitializer() {
  const hasLoadedRef = useRef(false);
  const { enableClaudeModels } = useFlags();

  // Model filtering: re-runs when enableClaudeModels flag changes
  useEffect(() => {
    const { setModels } = useSettingsStore.getState();

    // enableClaudeModels: defaults to true when LD is not configured (undefined !== false)
    const models: OpenAIModel[] = Object.values(OpenAIModels).filter(
      (m) =>
        !m.isDisabled &&
        !isModelDisabled(m.id) &&
        (m.provider !== 'anthropic' || enableClaudeModels !== false),
    );
    setModels(models);
  }, [enableClaudeModels]);

  // One-time initialization
  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    try {
      const { defaultModelId, setDefaultModelId } = useSettingsStore.getState();
      const {
        conversations,
        selectedConversationId,
        selectConversation,
        setIsLoaded,
      } = useConversationStore.getState();

      // Get current models (already set by the model filtering effect above)
      const models = useSettingsStore.getState().models;

      // Set default model if not already persisted
      if (!defaultModelId && models.length > 0) {
        const envDefaultModelId = getDefaultModel();
        const defaultModel =
          models.find((m) => m.id === envDefaultModelId) || models[0];
        if (defaultModel) {
          console.log(
            `[AppInitializer] No persisted defaultModelId found. Setting default to environment config: ${defaultModel.id}`,
          );
          setDefaultModelId(defaultModel.id as OpenAIModelID);
        }
      } else if (defaultModelId) {
        console.log(
          `[AppInitializer] Using persisted defaultModelId: ${defaultModelId}`,
        );
      }

      // Validate selected conversation exists
      if (
        selectedConversationId &&
        !conversations.find((c) => c.id === selectedConversationId)
      ) {
        if (conversations.length > 0) {
          selectConversation(conversations[0].id);
        } else {
          selectConversation(null);
        }
      }

      // Mark as loaded
      setIsLoaded(true);
    } catch (error) {
      console.error('Error initializing app state:', error);
      useConversationStore.getState().setIsLoaded(true);
    }
  }, []); // Empty deps - only run once

  return null; // This component doesn't render anything
}
