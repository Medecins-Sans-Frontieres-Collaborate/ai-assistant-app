'use client';

import {
  IconBrandWindows,
  IconPlugConnected,
  IconRobot,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import {
  findAttachedAgent,
  useAvailableAgents,
} from '@/client/hooks/settings/useAvailableAgents';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import {
  M365_BUILTIN_SERVER_ID,
  M365_BUILTIN_SERVER_LABEL,
} from '@/lib/services/m365/tools/toolCatalog';

import {
  AvailableAgent,
  agentModelSemantics,
  attachAgentUpdates,
} from '@/lib/utils/app/agentAttachment';

import { Conversation } from '@/types/chat';
import { SearchMode } from '@/types/searchMode';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';
import { v4 as uuidv4 } from 'uuid';

/**
 * One selectable row: an agent or an MCP connector. Users shouldn't need
 * to understand the difference to get value — everything here is "something
 * you can add to this chat" — so the two kinds share one list, one search,
 * and one primary action, distinguished only by icon and a small kind
 * label.
 */
interface BrowserItem {
  /** Usage-ordering key: agent id, or `connector-<serverId>`. */
  id: string;
  name: string;
  description?: string;
  kindLabel: string;
  semanticsLabel?: string;
  icon: 'agent' | 'connector' | 'm365';
  agent?: AvailableAgent;
  connectorId?: string;
  needsReauth?: boolean;
  /** Agent already attached / connector already on for this chat. */
  activeInChat: boolean;
}

/**
 * The agent & connector browser: one searchable, keyboard-navigable list
 * over every agent the user can reach plus their configured MCP connectors
 * (and the builtin Microsoft 365 toolset). Opened from the sidebar and the
 * capabilities tray; "Add to this chat" is ALWAYS the primary action —
 * "New chat" is the secondary for agents (and the fallback primary when no
 * conversation is selected).
 *
 * Ordering follows the model-picker principle: most-selected first
 * (settingsStore.agentBrowserUsage), default order as the tiebreaker.
 *
 * Keyboard: ↑/↓ move the highlight, Enter runs the primary action on the
 * highlighted row, Escape clears the query (and closes once it's empty).
 */
export function AgentBrowserModal() {
  const t = useTranslations('agentAttach');
  const tPin = useTranslations('connectorPin');
  const open = useUIStore((s) => s.agentBrowserOpen);
  const setOpen = useUIStore((s) => s.setAgentBrowserOpen);
  const { agents, isLoading } = useAvailableAgents();
  const {
    conversations,
    selectedConversation,
    addConversation,
    selectConversation,
    updateConversation,
  } = useConversations();
  const {
    models,
    defaultModelId,
    systemPrompt,
    temperature,
    defaultSearchMode,
    defaultInterpreterMode,
  } = useSettings();
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const updateMcpServer = useSettingsStore((s) => s.updateMcpServer);
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const m365ToolsUserEnabled = useSettingsStore((s) => s.m365ToolsUserEnabled);
  const setM365ToolsUserEnabled = useSettingsStore(
    (s) => s.setM365ToolsUserEnabled,
  );
  const agentBrowserUsage = useSettingsStore((s) => s.agentBrowserUsage);
  const incrementAgentBrowserUsage = useSettingsStore(
    (s) => s.incrementAgentBrowserUsage,
  );
  const { toolsEnabled: m365ToolsFlagOn } = useM365Enabled();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const attachedAgent = findAttachedAgent(agents, selectedConversation);
  const chatDisabledIds = useMemo(
    () => selectedConversation?.disabledMcpServerIds ?? [],
    [selectedConversation?.disabledMcpServerIds],
  );

  // Default order: agents (discovery order), then the M365 toolset, then
  // configured connectors. Usage re-ranks on top of this below.
  const allItems = useMemo<BrowserItem[]>(() => {
    const items: BrowserItem[] = agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      kindLabel: t(`kind.${agent.kind}`),
      semanticsLabel: t(`semantics.${agentModelSemantics(agent.kind)}`),
      icon: 'agent' as const,
      agent,
      activeInChat: !!attachedAgent && attachedAgent.id === agent.id,
    }));
    if (m365ToolsFlagOn && m365Connected) {
      items.push({
        id: `connector-${M365_BUILTIN_SERVER_ID}`,
        name: M365_BUILTIN_SERVER_LABEL,
        kindLabel: t('kind.connector'),
        icon: 'm365' as const,
        connectorId: M365_BUILTIN_SERVER_ID,
        activeInChat:
          m365ToolsUserEnabled &&
          !chatDisabledIds.includes(M365_BUILTIN_SERVER_ID),
      });
    }
    for (const server of mcpServers) {
      const needsReauth =
        server.authMode === 'oauth' && !!server.oauth?.needsReauth;
      items.push({
        id: `connector-${server.id}`,
        name: server.name,
        kindLabel: t('kind.connector'),
        icon: 'connector' as const,
        connectorId: server.id,
        needsReauth,
        activeInChat: server.enabled && !chatDisabledIds.includes(server.id),
      });
    }
    return items;
  }, [
    agents,
    attachedAgent,
    m365ToolsFlagOn,
    m365Connected,
    m365ToolsUserEnabled,
    mcpServers,
    chatDisabledIds,
    t,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = q
      ? allItems.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            item.description?.toLowerCase().includes(q) ||
            item.agent?.category?.toLowerCase().includes(q),
        )
      : allItems;
    // Usage ranking (model-picker principle): most-selected first; sort()
    // is stable, so ties keep the default order above.
    return [...matching].sort(
      (a, b) => (agentBrowserUsage[b.id] ?? 0) - (agentBrowserUsage[a.id] ?? 0),
    );
  }, [allItems, query, agentBrowserUsage]);

  // Derived, never set from an effect: the highlight is clamped to a real
  // row at render time, so list shrinkage (filtering) can't strand it.
  const highlightIndex =
    filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  useEffect(() => {
    // Optional call: jsdom (tests) has no scrollIntoView.
    document
      .getElementById(`agent-browser-item-${highlightIndex}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [highlightIndex]);

  if (!open) return null;

  const close = () => {
    setQuery('');
    setActiveIndex(0);
    setOpen(false);
  };
  const canAttach = !!selectedConversation;

  const attachAgentToCurrent = (agent: AvailableAgent) => {
    if (!selectedConversation) return;
    incrementAgentBrowserUsage(agent.id);
    updateConversation(
      selectedConversation.id,
      attachAgentUpdates(selectedConversation, agent),
    );
    close();
  };

  const startNewChat = (agent: AvailableAgent) => {
    const defaultModel =
      models.find((m) => m.id === defaultModelId) ?? models[0];
    const model = agent.foundryModel ?? defaultModel;
    if (!model) return;
    incrementAgentBrowserUsage(agent.id);

    // Same AGENT-mode auto-fix as the sidebar's new-chat path.
    let searchMode = defaultSearchMode;
    if (searchMode === SearchMode.AGENT && !model.agentId) {
      searchMode = SearchMode.INTELLIGENT;
    }

    const attachment = attachAgentUpdates(
      { model, bot: undefined, threadId: undefined },
      agent,
    );

    // Reuse the latest still-empty plain conversation instead of orphaning
    // it (mirrors Sidebar.handleNewConversation).
    const latest = conversations[0];
    if (latest && latest.messages.length === 0 && !latest.conversationType) {
      updateConversation(latest.id, {
        model,
        ...attachment,
        defaultSearchMode: searchMode,
      });
      selectConversation(latest.id);
      close();
      return;
    }

    const conversation: Conversation = {
      id: uuidv4(),
      name: '',
      messages: [],
      model,
      prompt: systemPrompt || '',
      temperature: temperature || 0.5,
      folderId: null,
      defaultSearchMode: searchMode,
      defaultInterpreterMode,
      ...attachment,
    };
    addConversation(conversation);
    selectConversation(conversation.id);
    close();
  };

  // Same one-click semantics as the `+` menu's connector toggles: enabling
  // a globally-off connector revives it globally AND clears the per-chat
  // opt-out; disabling only opts this chat out.
  const toggleConnector = (item: BrowserItem) => {
    if (!selectedConversation || !item.connectorId) return;
    const id = item.connectorId;
    if (!item.activeInChat) incrementAgentBrowserUsage(item.id);
    if (id === M365_BUILTIN_SERVER_ID) {
      if (!m365ToolsUserEnabled) {
        setM365ToolsUserEnabled(true);
        if (chatDisabledIds.includes(id)) {
          updateConversation(selectedConversation.id, {
            disabledMcpServerIds: chatDisabledIds.filter((d) => d !== id),
          });
        }
        return;
      }
    } else {
      const server = mcpServers.find((s) => s.id === id);
      if (server && !server.enabled) {
        updateMcpServer(id, { enabled: true });
        if (chatDisabledIds.includes(id)) {
          updateConversation(selectedConversation.id, {
            disabledMcpServerIds: chatDisabledIds.filter((d) => d !== id),
          });
        }
        return;
      }
    }
    updateConversation(selectedConversation.id, {
      disabledMcpServerIds: item.activeInChat
        ? [...chatDisabledIds, id]
        : chatDisabledIds.filter((d) => d !== id),
    });
  };

  /** Enter / row-click behavior: always "add to this chat" first. */
  const primaryAction = (item: BrowserItem) => {
    if (item.needsReauth) return;
    if (item.agent) {
      if (canAttach) {
        if (!item.activeInChat) attachAgentToCurrent(item.agent);
      } else {
        startNewChat(item.agent);
      }
      return;
    }
    toggleConnector(item);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(Math.min(highlightIndex + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(Math.max(highlightIndex - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[highlightIndex];
      if (item) primaryAction(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Don't bubble to the dialog's catch-all Escape handler — that would
      // turn "clear the field" into "clear and close".
      e.stopPropagation();
      // First Escape clears the query; a second (empty field) closes.
      if (query) setQuery('');
      else close();
    }
  };

  const itemIcon = (item: BrowserItem) => {
    if (item.icon === 'agent') {
      return (
        <IconRobot
          size={18}
          className="mt-0.5 flex-shrink-0 text-violet-500"
          aria-hidden="true"
        />
      );
    }
    if (item.icon === 'm365') {
      return (
        <IconBrandWindows
          size={18}
          className="mt-0.5 flex-shrink-0 text-blue-500"
          aria-hidden="true"
        />
      );
    }
    return (
      <IconPlugConnected
        size={18}
        className={`mt-0.5 flex-shrink-0 ${
          item.needsReauth ? 'text-amber-500' : 'text-cyan-600'
        }`}
        aria-hidden="true"
      />
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-fade-in-fast"
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('browserTitle')}
    >
      <div
        className="relative flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-surface-dark animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-shrink-0 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('browserTitle')}
            </h3>
            <button
              onClick={close}
              className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
              aria-label={t('close')}
            >
              <IconX size={20} />
            </button>
          </div>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {t('browserSubtitle')}
          </p>
          <div className="relative mt-3">
            <IconSearch
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              aria-hidden="true"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
              placeholder={t('searchPlaceholder')}
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls="agent-browser-list"
              aria-activedescendant={
                filtered.length > 0
                  ? `agent-browser-item-${highlightIndex}`
                  : undefined
              }
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {isLoading && filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('loading')}
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
              {query ? t('noMatches') : t('noAgents')}
            </p>
          ) : (
            <ul id="agent-browser-list" role="listbox" className="space-y-1">
              {filtered.map((item, index) => {
                const isActive = index === highlightIndex;
                return (
                  <li
                    key={item.id}
                    id={`agent-browser-item-${index}`}
                    role="option"
                    aria-selected={isActive}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => primaryAction(item)}
                    className={`group flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 ${
                      isActive
                        ? 'bg-gray-100 dark:bg-gray-800'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-800/60'
                    }`}
                  >
                    {itemIcon(item)}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                          {item.name}
                        </span>
                        <span className="flex-shrink-0 text-[11px] text-gray-500 dark:text-gray-400">
                          {item.kindLabel}
                          {item.semanticsLabel
                            ? ` · ${item.semanticsLabel}`
                            : ''}
                        </span>
                      </div>
                      {item.description && (
                        <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                          {item.description}
                        </p>
                      )}
                      {item.needsReauth && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          {tPin('needsReconnect')}
                        </p>
                      )}
                    </div>
                    <div
                      className="flex flex-shrink-0 items-center gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {item.agent ? (
                        <>
                          {canAttach && (
                            <button
                              type="button"
                              disabled={item.activeInChat}
                              onClick={() => attachAgentToCurrent(item.agent!)}
                              className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-default disabled:opacity-50"
                            >
                              {item.activeInChat
                                ? t('attached')
                                : t('addToChat')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => startNewChat(item.agent!)}
                            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                              canAttach
                                ? 'text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/30'
                                : 'bg-blue-600 font-medium text-white hover:bg-blue-700'
                            }`}
                          >
                            {t('newChat')}
                          </button>
                        </>
                      ) : (
                        canAttach && (
                          <button
                            type="button"
                            disabled={item.needsReauth}
                            onClick={() => toggleConnector(item)}
                            className={`rounded-md px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-50 ${
                              item.activeInChat
                                ? 'text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700'
                                : 'bg-blue-600 font-medium text-white hover:bg-blue-700'
                            }`}
                          >
                            {item.activeInChat
                              ? t('removeFromChat')
                              : t('addToChat')}
                          </button>
                        )
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
