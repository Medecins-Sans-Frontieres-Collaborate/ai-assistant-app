'use client';

import {
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconMenu2,
} from '@tabler/icons-react';
import { Suspense, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useUI } from '@/client/hooks/ui/useUI';

import { Tooltip } from '@/components/UI/Tooltip';

import { WorkflowModelSelect } from './WorkflowModelSelect';
import { WorkflowRail } from './WorkflowRail';
import { WorkflowTabs, useWorkflowTabsEnabled } from './WorkflowTabs';
import { WORKFLOW_REGISTRY } from './registry';

/**
 * Layout root for workflow conversations: a header with the workflow badge,
 * the specialized workspace as the primary surface, and the conversation
 * rail as a collapsible secondary pane. On mobile the two panes become tabs.
 *
 * Renders from `conversationType` alone — deliberately not gated by the
 * LaunchDarkly flag, so existing workflow conversations always open even
 * after the flag is turned off.
 */
export function WorkflowShell() {
  const t = useTranslations('workflows');
  const { selectedConversation } = useConversations();
  const { toggleChatbar } = useUI();
  const tabsEnabled = useWorkflowTabsEnabled();
  const [railOpen, setRailOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<'workspace' | 'conversation'>(
    'workspace',
  );

  const type = selectedConversation?.conversationType;
  if (!selectedConversation || !type) return null;

  const showTabs = tabsEnabled && selectedConversation.messages.length === 0;

  const definition = WORKFLOW_REGISTRY[type];
  if (!definition) {
    // Unknown type (e.g. data from a newer version): fail safe with the rail
    // only, so the conversation content stays reachable.
    return (
      <div className="flex h-full w-full flex-col bg-white dark:bg-surface-dark">
        <div className="flex items-center gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
          <p className="min-w-0 flex-1 text-sm text-gray-600 dark:text-gray-300">
            {t('shell.unknownType')}
          </p>
          {/* The workspace can't render, so the tabs are the way out —
              no tab reads as active, and Chat gets the user unstuck. */}
          {showTabs && <WorkflowTabs />}
        </div>
        <WorkflowRail conversation={selectedConversation} />
      </div>
    );
  }

  const Icon = definition.meta.icon;
  const typeLabel = t(`types.${definition.meta.i18nKey}.label`);
  const Workspace = definition.Workspace;

  const workspacePane = (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center">
            <p className="animate-pulse text-sm text-gray-500 dark:text-gray-400">
              {t('shell.loadingWorkspace')}
            </p>
          </div>
        }
      >
        <Workspace conversationId={selectedConversation.id} />
      </Suspense>
    </div>
  );

  const railPane = (
    <div className="flex h-full w-full flex-col border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-surface-dark-recessed md:w-[380px] md:shrink-0 md:border-s">
      <WorkflowRail conversation={selectedConversation} />
    </div>
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-white dark:bg-surface-dark">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
        <button
          type="button"
          onClick={toggleChatbar}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-surface-dark-elevated md:hidden"
          aria-label={t('shell.toggleMenu')}
        >
          <IconMenu2 size={20} aria-hidden />
        </button>
        {/* Header order mirrors the chat topbar — model on the leading
            edge, mode tabs on the trailing edge — so the two surfaces
            don't read as mirror images of each other. */}
        <div className="hidden sm:block">
          <WorkflowModelSelect conversation={selectedConversation} />
        </div>

        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
          {selectedConversation.name || t('shell.untitled')}
        </h1>

        {/* While the conversation is still empty its type is changeable, so
            the tabs stand in for the badge — the active tab already names
            the workflow, and showing both would say it twice. Once there
            are messages the type is settled and the static badge returns. */}
        {showTabs ? (
          <WorkflowTabs />
        ) : (
          <span
            className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300"
            title={t(`types.${definition.meta.i18nKey}.description`)}
          >
            <Icon size={14} aria-hidden />
            {typeLabel}
          </span>
        )}

        {/* Mobile: pane tabs */}
        <div
          role="tablist"
          aria-label={t('shell.paneTabsLabel')}
          className="flex rounded-lg bg-gray-100 p-0.5 dark:bg-surface-dark-elevated md:hidden"
        >
          {(['workspace', 'conversation'] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={mobileTab === tab}
              onClick={() => setMobileTab(tab)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                mobileTab === tab
                  ? 'bg-white text-gray-900 dark:bg-surface-dark dark:text-gray-100'
                  : 'text-gray-600 dark:text-gray-400'
              }`}
            >
              {tab === 'workspace'
                ? t('shell.workspaceTab')
                : t('shell.conversationTab')}
            </button>
          ))}
        </div>

        {/* Desktop: rail toggle */}
        <div className="hidden md:block">
          <Tooltip
            content={
              railOpen
                ? t('shell.hideConversation')
                : t('shell.showConversation')
            }
            position="bottom"
          >
            <button
              type="button"
              aria-pressed={railOpen}
              aria-label={
                railOpen
                  ? t('shell.hideConversation')
                  : t('shell.showConversation')
              }
              onClick={() => setRailOpen((open) => !open)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
            >
              {railOpen ? (
                <IconLayoutSidebarRightCollapse size={18} aria-hidden />
              ) : (
                <IconLayoutSidebarRightExpand size={18} aria-hidden />
              )}
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Body: side-by-side on desktop, tabbed on mobile */}
      <div className="hidden min-h-0 flex-1 md:flex">
        {workspacePane}
        {railOpen && railPane}
      </div>
      <div className="flex min-h-0 flex-1 md:hidden">
        {mobileTab === 'workspace' ? workspacePane : railPane}
      </div>
    </div>
  );
}
