'use client';

import { useTranslations } from 'next-intl';

import { specNameOf } from '@/client/services/workflows/drafter/specNames';

import { getSpecAdapter } from '@/lib/utils/shared/drafter/adapters';
import { hasText } from '@/lib/utils/shared/drafter/core/versions';

import { DraftSetState } from '@/types/drafter';

import { WorkflowWorkspaceProps } from '@/components/Workflows/registry';

import { useConversationStore } from '@/client/stores/conversationStore';
import {
  EVERY_SPEC,
  useWorkflowRailStore,
} from '@/client/stores/workflowRailStore';

/** Which kind of spec each drafter workflow writes for. */
const SPEC_KIND: Record<string, string> = { 'channel-drafter': 'channel' };

/**
 * The rail's "To:" line: who the next instruction is addressed to, always
 * visible before sending, like the recipient of an email. The workspace sets
 * it from context (all channels in Compare, one in Focus, one post when a
 * post is being edited); here the user can see it and change it.
 */
export function RevisionScopeLine({ conversationId }: WorkflowWorkspaceProps) {
  const t = useTranslations('workflows.drafter');
  const state = useConversationStore((s) => {
    const found = s.conversations.find(
      (c) => c.id === conversationId,
    )?.workflowState;
    return found && found.kind in SPEC_KIND
      ? (found as DraftSetState & { kind: string })
      : undefined;
  });
  const scope =
    useWorkflowRailStore((s) => s.scopes[conversationId]) ?? EVERY_SPEC;
  const setScope = useWorkflowRailStore((s) => s.setScope);

  const adapter = state ? getSpecAdapter(SPEC_KIND[state.kind]) : undefined;
  if (!state || !adapter) return null;

  const written = state.specIds.filter((id) => hasText(state.versions[id]));
  if (written.length === 0) return null;

  const nameOf = (id: string) => specNameOf(id, adapter.resolveSpec(id)?.name);
  const everyone = scope.specIds.length === 0;
  const postIndex =
    scope.segmentId && scope.specIds.length === 1
      ? (state.versions[scope.specIds[0]]?.segments.findIndex(
          (segment) => segment.id === scope.segmentId,
        ) ?? -1)
      : -1;

  const toggle = (id: string) => {
    const current = everyone ? [] : scope.specIds;
    const next = current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id];
    // Every written channel ticked is the same as "All channels".
    setScope(conversationId, {
      specIds: next.length === written.length ? [] : next,
    });
  };

  return (
    <fieldset className="mb-2 text-xs text-gray-700 dark:text-gray-300">
      <legend className="sr-only">{t('reviseTo')}</legend>
      <div className="flex flex-wrap items-center gap-1">
        <span className="font-medium">{t('reviseTo')}</span>
        <button
          type="button"
          aria-pressed={everyone}
          className={`min-h-[28px] rounded-md px-2 py-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
            everyone
              ? 'bg-blue-600 text-white'
              : 'hover:bg-gray-100 dark:hover:bg-surface-dark-elevated'
          }`}
          onClick={() => setScope(conversationId, EVERY_SPEC)}
        >
          {t('allChannels')}
        </button>
        {written.map((id) => {
          const on = !everyone && scope.specIds.includes(id);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              className={`min-h-[28px] rounded-md px-2 py-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                on
                  ? 'bg-blue-600 text-white'
                  : 'hover:bg-gray-100 dark:hover:bg-surface-dark-elevated'
              }`}
              onClick={() => toggle(id)}
            >
              {nameOf(id)}
              {on && postIndex >= 0 && ` · ${t('postN', { n: postIndex + 1 })}`}
            </button>
          );
        })}
      </div>
      {postIndex >= 0 && (
        <button
          type="button"
          className="mt-1 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          onClick={() => setScope(conversationId, { specIds: scope.specIds })}
        >
          {t('wholeChannel')}
        </button>
      )}
    </fieldset>
  );
}
