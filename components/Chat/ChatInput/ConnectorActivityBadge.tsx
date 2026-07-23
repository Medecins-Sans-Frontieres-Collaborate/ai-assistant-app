'use client';

import { IconPlugConnected } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Compact badge in the composer showing that MCP connectors are ACTIVE for
 * outgoing messages — active tools have real performance and token cost,
 * so their presence must be visible, not something to remember from
 * Settings. Shows the focused connector's name when a pin is set,
 * otherwise the active count. Clicking toggles the connector tray, where
 * individual connectors can be switched off or focused.
 *
 * Renders nothing when no connector is active FOR THIS CHAT (nothing is
 * being sent) — globally enabled servers this conversation opted out of
 * don't count. The connectors list then remains reachable through the `+`
 * menu.
 */
export const ConnectorActivityBadge: React.FC = () => {
  const t = useTranslations('connectorPin');
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const trayOpen = useChatInputStore((s) => s.connectorPinTrayOpen);
  const setTrayOpen = useChatInputStore((s) => s.setConnectorPinTrayOpen);
  const { selectedConversation } = useConversations();

  const active = mcpServers.filter(
    (s) =>
      s.enabled &&
      !(s.authMode === 'oauth' && s.oauth?.needsReauth) &&
      !selectedConversation?.disabledMcpServerIds?.includes(s.id),
  );
  if (active.length === 0) return null;

  const pinnedServer = selectedConversation?.pinnedMcpServerId
    ? active.find((s) => s.id === selectedConversation.pinnedMcpServerId)
    : undefined;
  // A name beats a count wherever one identifies the set: the focused
  // connector, or the only active one.
  const label = pinnedServer
    ? pinnedServer.name
    : active.length === 1
      ? active[0].name
      : t('badgeCount', { count: String(active.length) });

  return (
    <button
      type="button"
      onClick={() => setTrayOpen(!trayOpen)}
      aria-expanded={trayOpen}
      title={t('badgeTooltip')}
      className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
    >
      <IconPlugConnected
        size={14}
        className="text-blue-500"
        aria-hidden="true"
      />
      <span className="max-w-[7rem] truncate">{label}</span>
    </button>
  );
};
