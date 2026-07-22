'use client';

import { IconCheck, IconChevronDown, IconMessage } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import {
  KeyboardEvent,
  createElement,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

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

const iconFor = (tab: TabId) =>
  tab === CHAT_TAB ? IconMessage : WORKFLOW_META[tab].icon;

/**
 * Renders a tab's icon via `createElement` rather than binding it to a
 * capitalized local first: assigning a component to a variable during render
 * trips `react-hooks/static-components`. (The tablist branch below gets away
 * with `const Icon = ...` only because it sits inside a `.map()` callback.)
 */
function TabIcon({
  tab,
  size,
  className,
}: {
  tab: TabId;
  size: number;
  className?: string;
}) {
  return createElement(iconFor(tab), {
    size,
    'aria-hidden': true,
    className,
  });
}

/**
 * Two presentations, switched by CSS at `md` rather than by a prop or a JS
 * media query:
 *
 * - below `md`, the active mode plus a chevron, opening a bottom sheet with
 *   the full list. Five icons already crowd the model name on a phone and
 *   each new workflow would make it worse. It is a menu, not a tablist — the
 *   roving-tabindex contract doesn't survive collapsing to one control — and
 *   the sheet has room for the descriptions that `title` can never surface on
 *   touch.
 * - at `md` and up, the full ARIA tablist strip, unchanged.
 *
 * Both are rendered from one component instance so the pending-discard state
 * and ConfirmDialog exist once. A prop was the wrong shape here: WorkflowShell
 * renders the tabs at every width, so it had no breakpoint to key off.
 */

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
  /** `compact` only: whether the bottom sheet is showing. */
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  useEffect(() => {
    if (!isSheetOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setIsSheetOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isSheetOpen]);

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
      {/* Below md: active mode + chevron, opening the sheet below. */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isSheetOpen}
        aria-label={t('tabs.label')}
        onClick={() => setIsSheetOpen(true)}
        className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-gray-100 px-2 text-sm font-medium text-blue-600 transition-colors md:hidden dark:bg-surface-dark-elevated dark:text-blue-400"
      >
        <TabIcon tab={activeTab} size={16} />
        <span className="whitespace-nowrap">{labelFor(activeTab)}</span>
        <IconChevronDown size={14} className="opacity-60" aria-hidden />
      </button>

      {isSheetOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[10000] bg-black/40 backdrop-blur-sm animate-fade-in-fast"
              aria-hidden="true"
              onClick={() => setIsSheetOpen(false)}
            />
            <div
              role="menu"
              aria-label={t('tabs.label')}
              className="fixed inset-x-0 bottom-0 z-[10001] flex max-h-[75dvh] flex-col overflow-y-auto rounded-t-2xl border-t border-gray-200 bg-white shadow-lg outline-none animate-slide-up pb-[env(safe-area-inset-bottom)] dark:border-gray-700 dark:bg-surface-dark"
            >
              <div className="p-2">
                {TAB_IDS.map((tab) => {
                  const isActive = tab === activeTab;
                  return (
                    <button
                      key={tab}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      onClick={() => {
                        setIsSheetOpen(false);
                        selectTab(tab);
                      }}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-start transition-colors ${
                        isActive
                          ? 'bg-gray-100 dark:bg-surface-dark-elevated'
                          : 'hover:bg-gray-50 dark:hover:bg-surface-dark-elevated'
                      }`}
                    >
                      <TabIcon
                        tab={tab}
                        size={20}
                        className={`shrink-0 ${
                          isActive
                            ? 'text-blue-600 dark:text-blue-400'
                            : 'text-gray-500 dark:text-gray-400'
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block text-sm font-medium ${
                            isActive
                              ? 'text-blue-600 dark:text-blue-400'
                              : 'text-gray-900 dark:text-gray-100'
                          }`}
                        >
                          {labelFor(tab)}
                        </span>
                        {/* The description the icon strip could never show:
                              `title` never fires on touch. */}
                        <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                          {descriptionFor(tab)}
                        </span>
                      </span>
                      {isActive && (
                        <IconCheck
                          size={18}
                          aria-hidden
                          className="shrink-0 text-blue-600 dark:text-blue-400"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </>,
          document.body,
        )}

      {/* md and up: the full tablist, unchanged. */}
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('tabs.label')}
        aria-orientation="horizontal"
        className="hidden shrink-0 items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 md:flex dark:bg-surface-dark-elevated"
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
