'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';
import { useSession } from 'next-auth/react';
import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';

import { initMcpCredentialSync } from '@/client/services/mcp/mcpCredentialSync';

import { STORAGE_QUOTA_EXCEEDED_EVENT } from '@/lib/utils/app/storage/perConversationStorage';
import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';

import {
  ModelListSource,
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
} from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { getDefaultModel, getStaticModelList } from '@/config/models';

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
  const { data: session } = useSession();
  const sessionRegion = session?.user?.region ?? null;

  // Mirror the session's effective region into the settings store so vanilla
  // (non-hook) consumers — chatStore's selectability gate, the one-shot init
  // effect below — can read it. Reactive: follows session refetches and the
  // region-override cookie (auth applies the override into session.user.region).
  useEffect(() => {
    useSettingsStore.getState().setUserRegion(sessionRegion);
  }, [sessionRegion]);

  // Mirror the LaunchDarkly arbitrary-MCP flag into the settings store so
  // chatStore (vanilla, no hook access) can gate what gets SENT, not just
  // what's shown. Fail-closed on purpose: only an explicit `true` enables —
  // an unserved flag or LD outage must degrade to "arbitrary servers off".
  const { mcpArbitraryServers } = useFlags();
  useEffect(() => {
    useSettingsStore
      .getState()
      .setMcpArbitraryFlagEnabled(mcpArbitraryServers === true);
  }, [mcpArbitraryServers]);

  // MCP credential vault: once authenticated, merge encrypted credentials
  // into the in-memory store and start the write-through sync (the persisted
  // localStorage blob is secret-redacted; the vault key is session-bound).
  // Idempotent — initMcpCredentialSync guards against double-init.
  const isAuthenticated = !!session?.user;
  useEffect(() => {
    if (!isAuthenticated) return;
    void initMcpCredentialSync();
  }, [isAuthenticated]);

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

      // 1. Initialize models list from the vetted static list first, so the
      // picker renders instantly with current behavior. When model discovery
      // is on, step 4 below refines this from /api/models (region-correct,
      // deployment-driven).
      const models: OpenAIModel[] = getStaticModelList();
      setModels(models);
      useSettingsStore.getState().setModelListSource('static');

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

      // 4. Refine the model list from live discovery (non-blocking, always
      // on). The server returns the region-correct, ring-gated list — or the
      // vetted static list when discovery isn't configured/fails — so any
      // error here just keeps the static seed. We never block initial render
      // on this.
      {
        void (async () => {
          try {
            const res = await fetch('/api/models');
            if (!res.ok) return;
            const json = await res.json();
            // `json?.data?.models` is intentionally guarded by the Array.isArray
            // check below — an unexpected shape simply leaves the static list.
            const discovered = json?.data?.models as OpenAIModel[] | undefined;
            if (Array.isArray(discovered) && discovered.length > 0) {
              setModels(discovered);
              useSettingsStore
                .getState()
                .setModelListSource(
                  (json?.data?.source as ModelListSource | undefined) ?? null,
                );

              // The persisted defaultModelId may no longer exist in the
              // discovered list (region change, deployment removed, ring
              // gate), or may exist but not be selectable there. Re-resolve the
              // env default among SELECTABLE models only — discovered[0] can
              // be a foreign-region-only model (e.g. EU-only for a US user),
              // and defaulting onto it would break new conversations.
              const region = useSettingsStore.getState().userRegion;
              const selectable = discovered.filter((m) =>
                isModelSelectableInRegion(m, region),
              );
              const currentDefaultId =
                useSettingsStore.getState().defaultModelId;
              const stillPresent =
                currentDefaultId &&
                selectable.some((m) => m.id === currentDefaultId);
              if (!stillPresent) {
                // Resolve against the selectable DISCOVERED models so the
                // default tracks deployments (latest deployed standard GPT).
                const envDefaultModelId = getDefaultModel(selectable);
                const newDefault =
                  selectable.find((m) => m.id === envDefaultModelId) ||
                  selectable[0];
                if (newDefault) {
                  console.log(
                    `[AppInitializer] Persisted defaultModelId "${currentDefaultId}" not selectable in discovered list. Re-selecting default: ${newDefault.id}`,
                  );
                  setDefaultModelId(newDefault.id as OpenAIModelID);
                }
              }
            }
          } catch (e) {
            console.warn(
              '[AppInitializer] /api/models refine failed; keeping static list',
              e,
            );
          }
        })();
      }
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
