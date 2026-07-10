'use client';

import { WorkflowEventPayload } from '@/lib/streamMarkers';
import { create } from 'zustand';

/**
 * Transient state of in-flight workflow runs, keyed by conversation id.
 * Deliberately NOT persisted (same as artifactStore): a reload cancels the
 * run; durable results live on the conversation's workflowState.
 */
export interface WorkflowRun {
  isRunning: boolean;
  /** Latest transient activity (chat.activity.* key + params). */
  activityKey?: string;
  activityParams?: Record<string, string>;
  /** Aborts the in-flight fetch when the user cancels. */
  abortController?: AbortController;
  error?: string;
}

interface WorkflowRunStore {
  runs: Record<string, WorkflowRun>;

  startRun: (conversationId: string, abortController: AbortController) => void;
  setActivity: (
    conversationId: string,
    key: string,
    params?: Record<string, string>,
  ) => void;
  finishRun: (conversationId: string, error?: string) => void;
  cancelRun: (conversationId: string) => void;
  clearError: (conversationId: string) => void;
}

export const useWorkflowRunStore = create<WorkflowRunStore>()((set, get) => ({
  runs: {},

  startRun: (conversationId, abortController) =>
    set((state) => ({
      runs: {
        ...state.runs,
        [conversationId]: { isRunning: true, abortController },
      },
    })),

  setActivity: (conversationId, key, params) =>
    set((state) => {
      const run = state.runs[conversationId];
      if (!run?.isRunning) return state;
      return {
        runs: {
          ...state.runs,
          [conversationId]: {
            ...run,
            activityKey: key,
            activityParams: params,
          },
        },
      };
    }),

  finishRun: (conversationId, error) =>
    set((state) => ({
      runs: {
        ...state.runs,
        [conversationId]: {
          isRunning: false,
          error,
        },
      },
    })),

  cancelRun: (conversationId) => {
    get().runs[conversationId]?.abortController?.abort();
    set((state) => ({
      runs: {
        ...state.runs,
        [conversationId]: { isRunning: false },
      },
    }));
  },

  clearError: (conversationId) =>
    set((state) => {
      const run = state.runs[conversationId];
      if (!run) return state;
      return {
        runs: {
          ...state.runs,
          [conversationId]: { ...run, error: undefined },
        },
      };
    }),
}));

export type WorkflowEventHandler = (event: WorkflowEventPayload) => void;
