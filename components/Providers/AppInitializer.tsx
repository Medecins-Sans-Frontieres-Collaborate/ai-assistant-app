'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';
import { useSession } from 'next-auth/react';
import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';

import { useModelsQuery } from '@/client/hooks/settings/useModelsQuery';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import { initMcpCredentialSync } from '@/client/services/mcp/mcpCredentialSync';

import { STORAGE_QUOTA_EXCEEDED_EVENT } from '@/lib/utils/app/storage/perConversationStorage';
import {
  conversationUsesAgent,
  estimateConversationUsage,
} from '@/lib/utils/shared/chat/usageBackfill';

import { OpenAIModel, OpenAIModelID } from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import {
  TokenUsageBucket,
  tokenUsageKey,
  useSettingsStore,
} from '@/client/stores/settingsStore';
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
  const { mcpArbitraryServers, enableMemories, localModels } = useFlags();
  useEffect(() => {
    useSettingsStore
      .getState()
      .setMcpArbitraryFlagEnabled(mcpArbitraryServers === true);
  }, [mcpArbitraryServers]);

  // Mirror the LaunchDarkly memories flag the same way — chatStore gates the
  // send-path `memories` field and the post-stream extraction on it.
  // Fail-closed on purpose: only an explicit `true` enables — an unserved
  // flag or LD outage must degrade to "memories off".
  useEffect(() => {
    useSettingsStore.getState().setMemoriesFlagEnabled(enableMemories === true);
  }, [enableMemories]);

  // Mirror the LaunchDarkly local-models flag the same way. This one is the
  // feature's only kill switch: browser-direct loopback access depends on
  // browser behavior (Chrome's Local Network Access permission, enterprise
  // policy) that we cannot control or detect from here, so being able to turn
  // the whole thing off remotely matters. Fail-closed on purpose.
  useEffect(() => {
    useSettingsStore.getState().setLocalModelsFlagEnabled(localModels === true);
  }, [localModels]);

  // Mirror the builtin M365 toolset gate the same way — chatStore gates the
  // send-path builtin-m365 entry on it. Uses useM365Enabled (not the raw
  // flag) so the send gate and the tray/badge UI can never disagree: both
  // are fail-closed with the same documented localhost escape hatch.
  const { toolsEnabled: m365ToolsEnabled } = useM365Enabled();
  useEffect(() => {
    useSettingsStore.getState().setM365ToolsFlagEnabled(m365ToolsEnabled);
  }, [m365ToolsEnabled]);

  // MCP credential vault: once authenticated, merge encrypted credentials
  // into the in-memory store and start the write-through sync (the persisted
  // localStorage blob is secret-redacted; the vault key is session-bound).
  // Idempotent — initMcpCredentialSync guards against double-init.
  const isAuthenticated = !!session?.user;
  useEffect(() => {
    if (!isAuthenticated) return;
    void initMcpCredentialSync();
  }, [isAuthenticated]);

  // Live model list (formerly step 4 of the run-once effect below). A query
  // rather than a one-shot fetch so the picker follows policy saves, window
  // focus and quota denials — see useModelsQuery. Requires the
  // QueryClientProvider AppProviders wraps ChatShell (and so this) in.
  useModelsQuery();

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
      // picker renders instantly with current behavior on a COLD store.
      // useModelsQuery (mounted above) refines this from /api/models
      // (region-correct, deployment-driven) and keeps it fresh across
      // refetches.
      //
      // Guard against re-seeding a store a PRIOR mount already populated:
      // `settingsStore.models`/`modelListSource` are module-level and NOT
      // persisted to localStorage (see partialize), so they survive an
      // AppInitializer remount within the same page load (e.g. a
      // client-side navigation away from and back to the chat shell).
      // `useModelsQuery()` is mounted above this effect, so on such a
      // remount its data-effect runs FIRST (React runs a component's
      // passive effects in hook declaration order) and can already apply a
      // warm ['models'] cache hit; without this guard this effect would
      // then unconditionally clobber that back to the static, unfiltered,
      // un-ring-gated seed — the exact "blocked model is visible again"
      // regression docs/LIMITS_USER_FACING_UX.md §1b/§3b describes.
      const existingModels = useSettingsStore.getState().models;
      const models: OpenAIModel[] =
        existingModels.length > 0 ? existingModels : getStaticModelList();
      if (existingModels.length === 0) {
        setModels(models);
        useSettingsStore.getState().setModelListSource('static');
      }

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

      // 3b. One-time back-calculation of emissions-relevant usage for chats
      // that predate token tracking (tokens approximated from stored text —
      // see usageBackfill.ts). Raw tokens only: CO2e stays display-time so
      // assumption edits remain retroactive. Runs regardless of the LD flag
      // (pure data prep; every UI surface is flag-gated). Failures stamp the
      // marker anyway so a corrupt conversation can't retry-loop every boot.
      try {
        const {
          historicalUsageBackfilledAt,
          tokenUsageFirstTrackedAt,
          mergeEstimatedUsage,
          markHistoricalBackfillDone,
        } = useSettingsStore.getState();
        if (historicalUsageBackfilledAt == null) {
          const merged: Record<string, TokenUsageBucket> = {};
          for (const conversation of conversations) {
            // Agent chats never had tracked usage and don't fit the
            // per-model emissions math — skip them entirely.
            if (conversationUsesAgent(conversation)) continue;
            const bucket = estimateConversationUsage(conversation, {
              onlyBeforeIso: tokenUsageFirstTrackedAt,
            });
            if (bucket.requests === 0) continue;
            const key = tokenUsageKey({
              modelId: conversation.model?.id ?? 'unknown',
              region: conversation.hostedRegion ?? null,
              reasoningEffort: conversation.reasoningEffort,
            });
            const existing = merged[key];
            merged[key] = {
              promptTokens: (existing?.promptTokens ?? 0) + bucket.promptTokens,
              completionTokens:
                (existing?.completionTokens ?? 0) + bucket.completionTokens,
              requests: (existing?.requests ?? 0) + bucket.requests,
            };
          }
          if (Object.keys(merged).length > 0) {
            mergeEstimatedUsage(merged);
          } else {
            markHistoricalBackfillDone();
          }
        }
      } catch (backfillError) {
        console.error(
          '[AppInitializer] Historical usage backfill failed; marking done to avoid retry loops',
          backfillError,
        );
        useSettingsStore.getState().markHistoricalBackfillDone();
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
