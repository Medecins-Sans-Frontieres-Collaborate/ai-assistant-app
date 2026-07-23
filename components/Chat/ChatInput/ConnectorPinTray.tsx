'use client';

import { IconPlugConnected, IconX } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Inline connector tray above the composer: one row per configured MCP
 * server with an enable/disable toggle (global — mirrors Settings →
 * Connectors) and a per-conversation FOCUS action (only the focused
 * connector's tools are declared to the model; see `applyMcpPin`).
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
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const updateMcpServer = useSettingsStore((s) => s.updateMcpServer);
  const setTrayOpen = useChatInputStore((s) => s.setConnectorPinTrayOpen);
  const { selectedConversation, updateConversation } = useConversations();

  if (!selectedConversation) return null;
  const pinnedId = selectedConversation.pinnedMcpServerId;
  const pinnedServer = pinnedId
    ? mcpServers.find((s) => s.id === pinnedId)
    : undefined;
  const pinnedUsable =
    !!pinnedServer?.enabled &&
    !(pinnedServer.authMode === 'oauth' && pinnedServer.oauth?.needsReauth);

  const setPin = (serverId: string | undefined) => {
    updateConversation(selectedConversation.id, {
      pinnedMcpServerId: serverId,
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

      {mcpServers.length === 0 ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('noEligibleConnectors')}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {mcpServers.map((server) => {
            const needsReauth =
              server.authMode === 'oauth' && !!server.oauth?.needsReauth;
            const isPinned = server.id === pinnedId;
            const focusable = server.enabled && !needsReauth;
            return (
              <li key={server.id} className="flex items-center gap-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={() =>
                      updateMcpServer(server.id, { enabled: !server.enabled })
                    }
                    aria-label={t('toggleServer', { name: server.name })}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
                  />
                  <span
                    className={`truncate text-xs ${
                      server.enabled
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
            ? t('pinnedHint', {
                name: pinnedServer?.name ?? t('unknownConnector'),
              })
            : t('staleHint')
          : t('costHint')}
      </p>
    </div>
  );
};
