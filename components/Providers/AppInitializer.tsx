'use client';

import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';

import { STORAGE_QUOTA_EXCEEDED_EVENT } from '@/lib/utils/app/storage/perConversationStorage';

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

  // Surface localStorage quota exhaustion as a toast so the user knows when
  // the persistence layer is silently dropping writes. The storage layer
  // dispatches this event (throttled to once per 30s) instead of importing
  // `toast` directly to keep that layer UI-agnostic.
  useEffect(() => {
    const onQuotaExceeded = () => {
      toast.error(
        'Browser storage is full. Recent changes may not be saved. Consider deleting old conversations.',
        { duration: 8000 },
      );
    };
    window.addEventListener(STORAGE_QUOTA_EXCEEDED_EVENT, onQuotaExceeded);
    return () => {
      window.removeEventListener(STORAGE_QUOTA_EXCEEDED_EVENT, onQuotaExceeded);
    };
  }, []);

  return null; // This component doesn't render anything
}
