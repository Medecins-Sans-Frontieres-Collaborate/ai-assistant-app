'use client';

import {
  IconBrandWindows,
  IconPlugConnected,
  IconX,
} from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import {
  M365_BUILTIN_SERVER_ID,
  M365_BUILTIN_SERVER_LABEL,
} from '@/lib/services/m365/tools/toolCatalog';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Inline connector tray above the composer: one row per configured MCP
 * server with a PER-CONVERSATION on/off switch, a global on/off action
 * (mirrors Settings → Connectors), and a per-conversation FOCUS action
 * (only the focused connector's tools are declared to the model; see
 * `applyMcpPin`).
 *
 * The per-chat switch is subtractive: it writes the server's id into the
 * conversation's `disabledMcpServerIds`, leaving the global config alone —
 * so "not in this chat" no longer means "off everywhere". A globally
 * disabled server shows its chat switch dimmed with a "global off" action
 * to bring it back without a trip to Settings.
 *
 * Opened from the `+` menu or the connector badge; also forced open while a
 * focus pin is set so the pin is never invisible state. The footer spells
 * out the cost angle: every enabled connector adds tool declarations
 * (tokens) and a listing round-trip to each message.
 *
 * A pin whose server has since been disabled/removed renders a stale
 * notice — the send path fails open (all tools go through) rather than
 * silently stripping every tool.
 */
export const ConnectorPinTray: FC = () => {
  const t = useTranslations('connectorPin');
  const tM365 = useTranslations('m365.tools');
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const updateMcpServer = useSettingsStore((s) => s.updateMcpServer);
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const m365ToolsUserEnabled = useSettingsStore((s) => s.m365ToolsUserEnabled);
  const setM365ToolsUserEnabled = useSettingsStore(
    (s) => s.setM365ToolsUserEnabled,
  );
  const { toolsEnabled: m365ToolsFlagOn } = useM365Enabled();
  const setTrayOpen = useChatInputStore((s) => s.setConnectorPinTrayOpen);
  const { selectedConversation, updateConversation } = useConversations();

  if (!selectedConversation) return null;
  const pinnedId = selectedConversation.pinnedMcpServerId;
  const chatDisabledIds = selectedConversation.disabledMcpServerIds ?? [];
  // Virtual Microsoft 365 row: not a store row — its "global toggle" is
  // m365ToolsUserEnabled, its per-chat toggle and focus pin ride the same
  // disabledMcpServerIds / pinnedMcpServerId machinery as real connectors.
  const m365RowVisible = m365ToolsFlagOn && m365Connected;
  const m365ChatEnabled =
    m365ToolsUserEnabled && !chatDisabledIds.includes(M365_BUILTIN_SERVER_ID);
  const pinnedIsM365 = pinnedId === M365_BUILTIN_SERVER_ID;
  const pinnedServer = pinnedId
    ? mcpServers.find((s) => s.id === pinnedId)
    : undefined;
  const pinnedName = pinnedIsM365
    ? M365_BUILTIN_SERVER_LABEL
    : (pinnedServer?.name ?? t('unknownConnector'));
  const pinnedUsable = pinnedIsM365
    ? m365RowVisible && m365ChatEnabled
    : !!pinnedServer?.enabled &&
      !chatDisabledIds.includes(pinnedServer.id) &&
      !(pinnedServer.authMode === 'oauth' && pinnedServer.oauth?.needsReauth);

  const setPin = (serverId: string | undefined) => {
    updateConversation(selectedConversation.id, {
      pinnedMcpServerId: serverId,
    });
  };

  const setChatEnabled = (serverId: string, enabled: boolean) => {
    const next = enabled
      ? chatDisabledIds.filter((id) => id !== serverId)
      : [...chatDisabledIds, serverId];
    updateConversation(selectedConversation.id, {
      disabledMcpServerIds: next,
    });
  };

  const close = () => setTrayOpen(false);

  return (
    <div
      className="relative mx-3 my-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1c1c1c] px-3 py-2"
      role="region"
      aria-label={t('trayLabel')}
    >
      <div className="flex items-center gap-2">
        <IconPlugConnected
          size={14}
          className="flex-shrink-0 text-blue-500"
          aria-hidden="true"
        />
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
          {t('trayTitle')}
        </span>
        <button
          type="button"
          onClick={close}
          className="ml-auto rounded-md p-1 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label={t('dismiss')}
          title={t('dismiss')}
        >
          <IconX size={14} />
        </button>
      </div>

      {mcpServers.length === 0 && !m365RowVisible ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('noEligibleConnectors')}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {m365RowVisible && (
            <li className="flex items-center gap-2">
              <label
                className={`flex min-w-0 flex-1 items-center gap-2 ${
                  m365ToolsUserEnabled ? 'cursor-pointer' : 'cursor-default'
                }`}
              >
                <input
                  type="checkbox"
                  checked={m365ChatEnabled}
                  disabled={!m365ToolsUserEnabled}
                  onChange={() =>
                    setChatEnabled(M365_BUILTIN_SERVER_ID, !m365ChatEnabled)
                  }
                  aria-label={t('toggleServerInChat', {
                    name: M365_BUILTIN_SERVER_LABEL,
                  })}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800"
                />
                <IconBrandWindows
                  size={14}
                  className="flex-shrink-0 text-blue-500"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span
                    className={`block truncate text-xs ${
                      m365ChatEnabled
                        ? 'text-gray-800 dark:text-gray-200'
                        : 'text-gray-400 dark:text-gray-500'
                    }`}
                  >
                    {M365_BUILTIN_SERVER_LABEL}
                  </span>
                  <span className="block truncate text-[11px] text-gray-500 dark:text-gray-400">
                    {tM365('trayDescription')}
                  </span>
                </span>
              </label>
              <button
                type="button"
                onClick={() => setM365ToolsUserEnabled(!m365ToolsUserEnabled)}
                title={t('globalToggleTitle', {
                  name: M365_BUILTIN_SERVER_LABEL,
                })}
                className={`flex-shrink-0 rounded-md px-1.5 py-0.5 text-[11px] transition-colors ${
                  m365ToolsUserEnabled
                    ? 'text-gray-400 dark:text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'
                    : 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/40'
                }`}
              >
                {m365ToolsUserEnabled ? t('globalOn') : t('globalOff')}
              </button>
              {pinnedIsM365 ? (
                <button
                  type="button"
                  onClick={() => setPin(undefined)}
                  className="flex-shrink-0 inline-flex items-center gap-1 rounded-md bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 px-2 py-0.5 text-xs text-blue-800 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-800/50 transition-colors"
                  title={t('unpin')}
                >
                  {t('focusedChip')}
                  <IconX size={11} aria-hidden="true" />
                </button>
              ) : (
                m365ChatEnabled && (
                  <button
                    type="button"
                    onClick={() => setPin(M365_BUILTIN_SERVER_ID)}
                    className="flex-shrink-0 rounded-md px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                  >
                    {t('focusAction')}
                  </button>
                )
              )}
            </li>
          )}
          {mcpServers.map((server) => {
            const needsReauth =
              server.authMode === 'oauth' && !!server.oauth?.needsReauth;
            const isPinned = server.id === pinnedId;
            const chatEnabled =
              server.enabled && !chatDisabledIds.includes(server.id);
            const focusable = chatEnabled && !needsReauth;
            return (
              <li key={server.id} className="flex items-center gap-2">
                {/* Per-chat switch: only meaningful while globally enabled */}
                <label
                  className={`flex min-w-0 flex-1 items-center gap-2 ${
                    server.enabled ? 'cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={chatEnabled}
                    disabled={!server.enabled}
                    onChange={() => setChatEnabled(server.id, !chatEnabled)}
                    aria-label={t('toggleServerInChat', {
                      name: server.name,
                    })}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800"
                  />
                  <span
                    className={`truncate text-xs ${
                      chatEnabled
                        ? 'text-gray-800 dark:text-gray-200'
                        : 'text-gray-400 dark:text-gray-500'
                    }`}
                  >
                    {server.name}
                  </span>
                </label>
                {needsReauth && (
                  <span className="flex-shrink-0 text-xs text-amber-600 dark:text-amber-400">
                    {t('needsReconnect')}
                  </span>
                )}
                {/* Global on/off: mirrors Settings → Connectors, so a
                    globally-off server can be brought back right here. */}
                <button
                  type="button"
                  onClick={() =>
                    updateMcpServer(server.id, { enabled: !server.enabled })
                  }
                  title={t('globalToggleTitle', { name: server.name })}
                  className={`flex-shrink-0 rounded-md px-1.5 py-0.5 text-[11px] transition-colors ${
                    server.enabled
                      ? 'text-gray-400 dark:text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'
                      : 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/40'
                  }`}
                >
                  {server.enabled ? t('globalOn') : t('globalOff')}
                </button>
                {isPinned ? (
                  <button
                    type="button"
                    onClick={() => setPin(undefined)}
                    className="flex-shrink-0 inline-flex items-center gap-1 rounded-md bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 px-2 py-0.5 text-xs text-blue-800 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-800/50 transition-colors"
                    title={t('unpin')}
                  >
                    {t('focusedChip')}
                    <IconX size={11} aria-hidden="true" />
                  </button>
                ) : (
                  focusable && (
                    <button
                      type="button"
                      onClick={() => setPin(server.id)}
                      className="flex-shrink-0 rounded-md px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                    >
                      {t('focusAction')}
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        {pinnedId
          ? pinnedUsable
            ? t('pinnedHint', { name: pinnedName })
            : t('staleHint')
          : t('chatToggleHint')}
      </p>
    </div>
  );
};
