'use client';

import { useCallback } from 'react';

import { useWorkflowRunStore } from '@/client/stores/workflowRunStore';
import { WorkflowEventPayload, scanStreamEvents } from '@/lib/streamMarkers';

export interface WorkflowStreamCallbacks {
  /** Structured workflow result events (analysis, revision, features…). */
  onEvent?: (event: WorkflowEventPayload) => void;
  /** Accumulated display text so far (e.g. a streaming translation). */
  onText?: (fullText: string, delta: string) => void;
}

export interface RunWorkflowStreamOptions extends WorkflowStreamCallbacks {
  conversationId: string;
  url: string;
  body: unknown;
}

/**
 * Runs a workflow API call and consumes its text/plain stream through the
 * shared sentinel-marker parser. Activity markers land in workflowRunStore
 * (driving the run indicator); WORKFLOW_EVENTs and display text go to the
 * caller. Resolves when the stream ends; throws on HTTP or network errors.
 */
export function useWorkflowStream() {
  const startRun = useWorkflowRunStore((s) => s.startRun);
  const setActivity = useWorkflowRunStore((s) => s.setActivity);
  const finishRun = useWorkflowRunStore((s) => s.finishRun);

  const runWorkflowStream = useCallback(
    async ({
      conversationId,
      url,
      body,
      onEvent,
      onText,
    }: RunWorkflowStreamOptions): Promise<void> => {
      const abortController = new AbortController();
      startRun(conversationId, abortController);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) {
          let message = `Request failed (${response.status})`;
          try {
            const parsed = await response.json();
            if (parsed?.error) message = String(parsed.error);
          } catch {
            // non-JSON error body
          }
          throw new Error(message);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        let processedIndex = 0;
        let displayText = '';
        let failed: string | null = null;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });

          const scan = scanStreamEvents(buffered, processedIndex);
          processedIndex = scan.nextIndex;

          for (const event of scan.events) {
            if (event.type === 'agent_activity') {
              setActivity(
                conversationId,
                event.payload.key,
                event.payload.params,
              );
            } else if (event.type === 'workflow_event') {
              if (event.payload.type === 'error') {
                const data = event.payload.data as { message?: string };
                failed = data?.message ?? 'Workflow failed';
              } else {
                onEvent?.(event.payload);
              }
            }
          }

          if (scan.displayDelta) {
            displayText += scan.displayDelta;
            onText?.(displayText, scan.displayDelta);
          }
        }

        if (failed) {
          throw new Error(failed);
        }

        finishRun(conversationId);
      } catch (error) {
        if (abortController.signal.aborted) {
          // User-cancelled: cancelRun already reset the run state.
          return;
        }
        const message =
          error instanceof Error ? error.message : 'Workflow failed';
        finishRun(conversationId, message);
        throw error;
      }
    },
    [startRun, setActivity, finishRun],
  );

  return { runWorkflowStream };
}
