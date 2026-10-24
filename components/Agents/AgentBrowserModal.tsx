'use client';

import {
  IconBook2,
  IconBox,
  IconBrandWindows,
  IconCheck,
  IconClock,
  IconCpu,
  IconLock,
  IconPlugConnected,
  IconSearch,
  IconUserCircle,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import {
  findAttachedAgent,
  useAvailableAgents,
} from '@/client/hooks/settings/useAvailableAgents';
import { formatResetIn } from '@/client/hooks/settings/useMyLimits';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import {
  M365_BUILTIN_SERVER_ID,
  M365_BUILTIN_SERVER_LABEL,
} from '@/lib/services/m365/tools/toolCatalog';

import {
  AvailableAgent,
  AvailableAgentKind,
  agentModelSemantics,
  attachAgentUpdates,
} from '@/lib/utils/app/agentAttachment';

import { Conversation } from '@/types/chat';
import { SearchMode, normalizeSearchMode } from '@/types/searchMode';

import { modelLimitCopy } from '@/components/Chat/ModelSelect/ModelLimitBadge';
import {
  pinnedModelAvailability,
  pinnedModelIdOf,
  pinnedModelName,
  useModelAvailabilityMap,
} from '@/components/Chat/ModelSelect/modelLimits';
import { Tooltip } from '@/components/UI/Tooltip';

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
  /**
   * Model-semantics note, set only when attaching changes which model
   * answers (pinned/own model). The default "uses your model" case is
   * covered once by the modal subtitle instead of repeating on each row.
   * Rendered as an icon tooltip at rest and as plain text on the active
   * row, so pointer, keyboard, and touch users all have a path to it.
   */
  semanticsLabel?: string;
  icon: 'knowledge' | 'persona' | 'custom' | 'connector' | 'm365';
  agent?: AvailableAgent;
  connectorId?: string;
  needsReauth?: boolean;
  /** Agent already attached / connector already on for this chat. */
  activeInChat: boolean;
  /**
   * The agent pins a model that is blocked or exhausted for this user —
   * shown as a note on the row, never as a reason to hide it (the agent
   * itself is not restricted; the send would 403 on the model).
   */
  modelUnavailableNote?: string;
  /** True for a permanent block (never resets) — picks the lock icon over the clock. */
  modelUnavailableBlocked?: boolean;
}

/** Key-cap chip in the footer legend (0.625rem = the micro ramp step). */
const KBD_CLASS =
  'rounded border border-gray-300 bg-gray-50 px-1 py-0.5 font-sans text-[0.625rem] font-medium text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300';

/** Row icon for an agent kind: shape carries the kind, never color alone. */
const agentIconKind = (kind: AvailableAgentKind): BrowserItem['icon'] => {
  if (kind === 'prompt') return 'persona';
  if (kind === 'foundry') return 'custom';
  if (kind === 'm365') return 'm365';
  return 'knowledge';
};

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
  const tLimits = useTranslations('limitsUx.picker');
  const open = useUIStore((s) => s.agentBrowserOpen);
  const setOpen = useUIStore((s) => s.setAgentBrowserOpen);
  const setIsSettingsOpen = useUIStore((s) => s.setIsSettingsOpen);
  const {
    agents,
    isLoading,
    isError,
    isDiscoveryLoading,
    isDiscoveryError,
    retry,
  } = useAvailableAgents();
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
  const limitsMap = useModelAvailabilityMap();
  // A snapshot, not a live tick: this only feeds the row note's static
  // countdown text (row hooks aren't available inside the allItems
  // useMemo). Calling Date.now() directly in render is impure; the lazy
  // initializer form runs once, on mount.
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const attachedAgent = findAttachedAgent(agents, selectedConversation);
  const chatDisabledIds = useMemo(
    () => selectedConversation?.disabledMcpServerIds ?? [],
    [selectedConversation?.disabledMcpServerIds],
  );

  // Default order: agents (discovery order), then the M365 toolset, then
  // configured connectors. Usage re-ranks on top of this below.
  const allItems = useMemo<BrowserItem[]>(() => {
    // Only pinned-model kinds can be limited through their model: prompt
    // agents (once discovery exposes the id) and Foundry swap targets.
    // "Your-model" kinds ride whatever the picker already vetted. Shares
    // ModelHeader's exact wording (`modelLimitCopy`) — including the reset
    // countdown when the server sent one — instead of a second, drifting
    // copy of the sentence.
    const modelNoteFor = (
      agent: AvailableAgent,
    ): { note?: string; blocked?: boolean } => {
      const semantics = agentModelSemantics(agent.kind);
      if (semantics === 'your-model') return {};
      const pinnedId = pinnedModelIdOf(agent);
      if (!pinnedId) return {};
      const view = pinnedModelAvailability(pinnedId, limitsMap, models);
      if (view.state === 'available') return {};
      const resets =
        view.state === 'exhausted' && view.resetAt
          ? formatResetIn(view.resetAt, now)
          : null;
      return {
        note:
          modelLimitCopy(tLimits, view, resets, pinnedModelName(pinnedId)) ??
          undefined,
        blocked: view.state === 'blocked',
      };
    };
    const items: BrowserItem[] = agents.map((agent) => {
      const { note, blocked } = modelNoteFor(agent);
      const semantics = agentModelSemantics(agent.kind);
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        kindLabel: t(`kind.${agent.kind}`),
        semanticsLabel:
          semantics === 'your-model' ? undefined : t(`semantics.${semantics}`),
        icon: agentIconKind(agent.kind),
        agent,
        activeInChat: !!attachedAgent && attachedAgent.id === agent.id,
        modelUnavailableNote: note,
        modelUnavailableBlocked: blocked,
      };
    });
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
    limitsMap,
    models,
    now,
    t,
    tLimits,
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

  // Focus management: move focus into the search field on open (manually,
  // not via autoFocus, so the previously focused trigger can be captured
  // first) and hand it back when the dialog closes.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, [open]);

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

    // A persisted AGENT default (retired routing) reads as INTELLIGENT.
    const searchMode = normalizeSearchMode(defaultSearchMode);

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

  /**
   * A connector that lost its OAuth grant can only be fixed in Settings;
   * activating its row goes there instead of silently doing nothing.
   */
  const openSettingsForReauth = () => {
    close();
    setIsSettingsOpen(true);
  };

  /** Enter / row-click behavior: always "add to this chat" first. */
  const primaryAction = (item: BrowserItem) => {
    if (item.needsReauth) {
      openSettingsForReauth();
      return;
    }
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
      if (!item) return;
      // Shift+Enter is the keyboard path to the secondary action ("New
      // chat" while a conversation is selected) — the per-row buttons are
      // pointer affordances, announced via the footer legend instead.
      if (e.shiftKey && item.agent && canAttach) startNewChat(item.agent);
      else primaryAction(item);
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

  // Keep Tab cycling inside the dialog (close button + search field; the
  // row buttons are pointer affordances at tabindex -1, reached by keyboard
  // through Enter / Shift+Enter on the combobox instead).
  const trapFocus = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusables = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Icon shape carries the kind; color stays neutral so the single-accent
  // palette holds (amber marks the one state that needs attention).
  const itemIcon = (item: BrowserItem) => {
    const neutral = 'mt-0.5 flex-shrink-0 text-gray-500 dark:text-gray-400';
    const props = { size: 18, 'aria-hidden': true } as const;
    switch (item.icon) {
      case 'persona':
        return <IconUserCircle {...props} className={neutral} />;
      case 'custom':
        return <IconBox {...props} className={neutral} />;
      case 'm365':
        return <IconBrandWindows {...props} className={neutral} />;
      case 'connector':
        return (
          <IconPlugConnected
            {...props}
            className={
              item.needsReauth
                ? 'mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400'
                : neutral
            }
          />
        );
      default:
        return <IconBook2 {...props} className={neutral} />;
    }
  };

  // The footer legend tracks the highlighted row so "Enter" always names
  // the exact thing it will do.
  const highlighted = filtered[highlightIndex];
  const enterHint = !highlighted
    ? null
    : highlighted.needsReauth
      ? tPin('needsReconnect')
      : highlighted.agent
        ? canAttach
          ? highlighted.activeInChat
            ? t('attached')
            : t('addToChat')
          : t('newChat')
        : highlighted.activeInChat
          ? t('removeFromChat')
          : t('addToChat');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-fade-in-fast"
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
        else trapFocus(e);
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('browserTitle')}
    >
      <div
        ref={panelRef}
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
              className="-m-2.5 rounded-lg p-3 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              aria-label={t('close')}
            >
              <IconX size={20} aria-hidden="true" />
            </button>
          </div>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">
            {t('browserSubtitle')}
          </p>
          <div className="relative mt-3">
            <IconSearch
              size={16}
              className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
              placeholder={t('searchPlaceholder')}
              role="combobox"
              aria-expanded={filtered.length > 0}
              aria-controls={
                filtered.length > 0 ? 'agent-browser-list' : undefined
              }
              aria-autocomplete="list"
              aria-describedby="agent-browser-hints"
              aria-activedescendant={
                filtered.length > 0
                  ? `agent-browser-item-${highlightIndex}`
                  : undefined
              }
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pe-3 ps-9 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-400"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {isLoading && filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('loading')}
            </p>
          ) : isError && allItems.length === 0 ? (
            // Keyed on the unfiltered list: typing a query must not turn a
            // failed load into "No matches" and hide Retry.
            <div className="px-3 py-6 text-center text-sm text-gray-600 dark:text-gray-300">
              <p>{t('loadError')}</p>
              <button
                type="button"
                onClick={retry}
                className="mt-3 rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-100 dark:border-gray-600 dark:text-white dark:hover:bg-gray-800"
              >
                {t('retry')}
              </button>
            </div>
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
                        ? 'bg-gray-100 ring-1 ring-inset ring-gray-300 dark:bg-gray-800 dark:ring-gray-600'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-800/60'
                    }`}
                  >
                    {itemIcon(item)}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {/* The name never loses the space fight: it owns the
                            flexible track and falls back to a title tooltip
                            when it still has to truncate. */}
                        <span
                          className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100"
                          title={item.name}
                        >
                          {item.name}
                        </span>
                        <span className="flex-shrink-0 text-xs text-gray-600 dark:text-gray-300">
                          {item.kindLabel}
                        </span>
                        {item.semanticsLabel && (
                          <span className="flex-shrink-0">
                            <Tooltip content={item.semanticsLabel}>
                              <IconCpu
                                size={14}
                                className="text-gray-500 dark:text-gray-400"
                                aria-hidden="true"
                              />
                            </Tooltip>
                          </span>
                        )}
                      </div>
                      {item.description && (
                        <p
                          className={`text-xs text-gray-600 dark:text-gray-300 ${
                            isActive ? '' : 'line-clamp-1'
                          }`}
                        >
                          {item.description}
                        </p>
                      )}
                      {isActive && item.semanticsLabel && (
                        <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">
                          {item.semanticsLabel}
                        </p>
                      )}
                      {item.needsReauth && (
                        <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={(e) => {
                              e.stopPropagation();
                              openSettingsForReauth();
                            }}
                            className="underline decoration-amber-800/40 underline-offset-2 hover:decoration-amber-800 dark:decoration-amber-300/40 dark:hover:decoration-amber-300"
                          >
                            {tPin('needsReconnect')}
                          </button>
                        </p>
                      )}
                      {item.modelUnavailableNote && (
                        <p
                          data-testid="agent-model-unavailable"
                          className="flex items-center gap-1 text-xs text-amber-800 dark:text-amber-300"
                        >
                          {item.modelUnavailableBlocked ? (
                            <IconLock size={12} aria-hidden="true" />
                          ) : (
                            <IconClock size={12} aria-hidden="true" />
                          )}
                          {item.modelUnavailableNote}
                        </p>
                      )}
                    </div>
                    {/* Pointer affordances only — hidden from assistive tech
                        (descendants of role="option" are presentational per
                        ARIA) and untabbable; the keyboard paths are Enter and
                        Shift+Enter on the combobox, named by the footer
                        legend. Shown on the active row for mouse users and
                        always on touch, where there is no hover to reveal
                        them. */}
                    <div
                      className={`flex-shrink-0 items-center gap-2 ${
                        isActive ? 'flex' : 'hidden [@media(hover:none)]:flex'
                      }`}
                      aria-hidden="true"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {item.agent ? (
                        <>
                          {canAttach &&
                            (item.activeInChat ? (
                              <span className="flex items-center gap-1 px-2 text-xs font-medium text-gray-600 dark:text-gray-300">
                                <IconCheck size={14} aria-hidden="true" />
                                {t('attached')}
                              </span>
                            ) : (
                              <button
                                type="button"
                                tabIndex={-1}
                                onClick={() =>
                                  attachAgentToCurrent(item.agent!)
                                }
                                className="min-h-9 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 [@media(pointer:coarse)]:min-h-11"
                              >
                                {t('addToChat')}
                              </button>
                            ))}
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() => startNewChat(item.agent!)}
                            className="min-h-9 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 [@media(pointer:coarse)]:min-h-11"
                          >
                            {t('newChat')}
                          </button>
                        </>
                      ) : (
                        canAttach &&
                        !item.needsReauth && (
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() => toggleConnector(item)}
                            className={`min-h-9 rounded-md px-3 py-1.5 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-11 ${
                              item.activeInChat
                                ? 'text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700'
                                : 'bg-blue-600 text-white hover:bg-blue-700'
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
          {isError && allItems.length > 0 && (
            // The fast half failed but bundled/static rows (or connectors)
            // still render: without this line the missing admin-managed
            // agents would just look absent.
            <p className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <span>{t('loadError')}</span>
              <button
                type="button"
                onClick={retry}
                className="rounded border border-amber-300 px-2 py-0.5 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/40"
              >
                {t('retry')}
              </button>
            </p>
          )}
          {!isError && isDiscoveryLoading && (
            <p
              className="px-3 py-2 text-center text-xs text-gray-500 dark:text-gray-400"
              aria-live="polite"
            >
              {t('discoveryLoading')}
            </p>
          )}
          {!isError && !isDiscoveryLoading && isDiscoveryError && (
            <p className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <span>{t('discoveryError')}</span>
              <button
                type="button"
                onClick={retry}
                className="rounded border border-amber-300 px-2 py-0.5 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/40"
              >
                {t('retry')}
              </button>
            </p>
          )}
        </div>

        {/* Keyboard legend: names what Enter will do on the highlighted row
            (and the Shift+Enter secondary), so the combobox-only keyboard
            model stays discoverable. Referenced by the input's
            aria-describedby; hidden on touch, where it doesn't apply. */}
        <div
          id="agent-browser-hints"
          className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-200 px-4 py-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300 [@media(pointer:coarse)]:hidden"
        >
          {enterHint && (
            <span className="flex items-center gap-1.5">
              <kbd className={KBD_CLASS}>↵</kbd>
              {enterHint}
            </span>
          )}
          {highlighted?.agent && canAttach && (
            <span className="flex items-center gap-1.5">
              <kbd className={KBD_CLASS}>⇧↵</kbd>
              {t('newChat')}
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <kbd className={KBD_CLASS}>Esc</kbd>
            {t('close')}
          </span>
        </div>
      </div>
    </div>
  );
}
