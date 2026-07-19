'use client';

import { IconMessage } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { KeyboardEvent, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';

import { CONVERSATION_WORKFLOW_TYPES } from '@/types/workflow';

import { ConfirmDialog } from '@/components/UI/ConfirmDialog';

import { createInitialWorkflowState } from './initialState';
import { WORKFLOW_META } from './registryMeta';
import { isWorkflowStatePristine } from './workflowDirty';

/** The default (untyped) conversation, shown as the first tab. */
const CHAT_TAB = 'chat' as const;

type TabId = typeof CHAT_TAB | (typeof CONVERSATION_WORKFLOW_TYPES)[number];

const TAB_IDS: readonly TabId[] = [CHAT_TAB, ...CONVERSATION_WORKFLOW_TYPES];

/**
 * Whether the workflow feature is available to this user at all.
 *
 * Shared so callers that swap something else out for the tabs (WorkflowShell
 * replaces its type badge) can tell "tabs hidden" from "tabs rendered", and
 * don't strand the user with neither. Fail-closed, matching every other
 * workflow surface: an LD outage hides the feature rather than launching it.
 * See docs/LAUNCHDARKLY_FLAGS.md.
 */
export function useWorkflowTabsEnabled(): boolean {
  const { conversationWorkflows } = useFlags();
  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1');
  return conversationWorkflows === true || isLocalhost;
}

/**
 * Mode switcher for the current conversation: plain chat, or one of the
 * workflows. Lives in the topbar slot the three-dot menu takes over once
 * the conversation has messages, so the two never coexist.
 *
 * Nothing here is a "create" action — these tabs re-type the conversation
 * the user is already in. That is only allowed while it has no messages;
 * conversationStore enforces the same rule, so a stale render can't slip a
 * type change past it. Sending the first message settles the type and the
 * strip stops rendering.
 *
 * Rendered by ChatTopbar, MobileChatHeader, and WorkflowShell. Each caller
 * gates on its own "has messages" notion; the guards below are the floor.
 */
export function WorkflowTabs() {
  const t = useTranslations('workflows');
  const enabled = useWorkflowTabsEnabled();
  const { selectedConversation, updateConversation } = useConversations();
  const listRef = useRef<HTMLDivElement>(null);
  /** Target of a switch waiting on the discard confirmation. */
  const [pendingTab, setPendingTab] = useState<TabId | null>(null);

  if (!enabled) return null;
  if (!selectedConversation || selectedConversation.messages.length > 0) {
    return null;
  }

  const activeType = selectedConversation.conversationType;
  const activeTab: TabId = activeType ?? CHAT_TAB;

  const commit = (tab: TabId) => {
    updateConversation(
      selectedConversation.id,
      tab === CHAT_TAB
        ? { conversationType: undefined, workflowState: undefined }
        : {
            conversationType: tab,
            workflowState: createInitialWorkflowState(tab),
          },
    );
  };

  const selectTab = (tab: TabId) => {
    if (tab === activeTab) return;
    // Leaving a workflow the user has already put something into is
    // destructive; leaving an untouched one is not.
    const needsConfirm =
      activeType !== undefined &&
      !isWorkflowStatePristine(selectedConversation.workflowState, activeType);
    if (needsConfirm) {
      setPendingTab(tab);
      return;
    }
    commit(tab);
  };

  /**
   * Manual activation: arrows move focus, Enter/Space commits. Automatic
   * activation would fire the discard dialog while the user is only
   * arrowing across the strip to read the labels.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const { key } = event;
    if (
      key !== 'ArrowRight' &&
      key !== 'ArrowLeft' &&
      key !== 'Home' &&
      key !== 'End'
    ) {
      return;
    }
    event.preventDefault();

    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ??
        [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(event.currentTarget);
    if (current === -1) return;

    let next: number;
    if (key === 'Home') {
      next = 0;
    } else if (key === 'End') {
      next = buttons.length - 1;
    } else {
      // Mirror arrow direction under RTL locales.
      const rtl =
        listRef.current !== null &&
        window.getComputedStyle(listRef.current).direction === 'rtl';
      const forward = rtl ? key === 'ArrowLeft' : key === 'ArrowRight';
      next = (current + (forward ? 1 : -1) + buttons.length) % buttons.length;
    }
    buttons[next]?.focus();
  };

  const labelFor = (tab: TabId) =>
    tab === CHAT_TAB
      ? t('tabs.chat')
      : t(`types.${WORKFLOW_META[tab].i18nKey}.label`);

  const descriptionFor = (tab: TabId) =>
    tab === CHAT_TAB
      ? t('tabs.chatDescription')
      : t(`types.${WORKFLOW_META[tab].i18nKey}.description`);

  return (
    <>
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('tabs.label')}
        aria-orientation="horizontal"
        // shrink-0: on a narrow phone the model name (min-w-0 + truncate)
        // gives way before the tabs do.
        className="flex shrink-0 items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-surface-dark-elevated"
      >
        {TAB_IDS.map((tab) => {
          const Icon = tab === CHAT_TAB ? IconMessage : WORKFLOW_META[tab].icon;
          const isActive = tab === activeTab;
          const label = labelFor(tab);
          return (
            // No Tooltip wrapper here: it renders an intervening div, and a
            // tablist must own its tabs directly. Native title instead.
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={isActive}
              // Roving tabindex: the strip is one tab stop, arrows move
              // within it.
              tabIndex={isActive ? 0 : -1}
              aria-label={label}
              title={descriptionFor(tab)}
              onClick={() => selectTab(tab)}
              onKeyDown={handleKeyDown}
              className={`inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors duration-150 md:h-8 md:min-h-0 ${
                isActive
                  ? 'bg-white text-blue-600 dark:bg-surface-dark dark:text-blue-400'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              <Icon size={16} aria-hidden />
              {/* Only the active tab is labelled, so the strip keeps a
                  predictable width in every locale — exactly one label is
                  ever rendered. Inactive tabs carry the same text as
                  aria-label + title. */}
              {isActive && (
                <span className="whitespace-nowrap duration-200 animate-in fade-in motion-reduce:animate-none">
                  {label}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <ConfirmDialog
        isOpen={pendingTab !== null}
        title={t('discard.title')}
        message={t('discard.body', {
          current: activeType ? labelFor(activeType) : '',
          target: pendingTab ? labelFor(pendingTab) : '',
        })}
        confirmLabel={t('discard.confirm')}
        confirmVariant="danger"
        onConfirm={() => {
          if (pendingTab) commit(pendingTab);
          setPendingTab(null);
        }}
        onCancel={() => setPendingTab(null)}
      />
    </>
  );
}
