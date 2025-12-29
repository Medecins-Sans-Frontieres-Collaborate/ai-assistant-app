'use client';

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
 * 1. Model filtering (based on environment config)
 * 2. Default model selection (from environment if not persisted)
 * 3. Selected conversation validation
 *
 * Note: Data migration from legacy localStorage is handled by MigrationDialog
 * in ChatShell.tsx to provide user feedback during the migration process.
 */
export function AppInitializer() {
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    // Ensure we only initialize once, even in React StrictMode
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    try {
      // Access stores directly for one-time initialization
      const { setModels, defaultModelId, setDefaultModelId } =
        useSettingsStore.getState();
      const {
        conversations,
        selectedConversationId,
        selectConversation,
        setIsLoaded,
      } = useConversationStore.getState();

      // 1. Initialize models list (filtered by environment)
      const models: OpenAIModel[] = Object.values(OpenAIModels).filter(
        (m) => !m.isDisabled && !isModelDisabled(m.id),
      );
      setModels(models);

      // 2. Set default model if not already persisted
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

      // 3. Validate selected conversation exists
      if (
        selectedConversationId &&
        !conversations.find((c) => c.id === selectedConversationId)
      ) {
        // Selected conversation no longer exists, select first available
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
      // On error, mark as loaded anyway to prevent blocking the app
      useConversationStore.getState().setIsLoaded(true);
    }
  }, []); // Empty deps - only run once

  return null; // This component doesn't render anything
}
