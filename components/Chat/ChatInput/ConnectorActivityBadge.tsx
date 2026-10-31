'use client';

import { IconPlugConnected } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import {
  M365_BUILTIN_SERVER_ID,
  M365_BUILTIN_SERVER_LABEL,
} from '@/lib/services/m365/tools/toolCatalog';

import { CapabilityBubble } from '@/components/Chat/ChatInput/CapabilityBubble';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Bubble in the composer's capability row showing that MCP connectors are
 * ACTIVE for outgoing messages (icon-first, name or count on hover/focus).
 * Active tools have real performance and token cost, so their presence
 * must be visible, not something to remember from Settings. Shows the
 * focused connector's name when a pin is set, otherwise the active count.
 * Clicking toggles the connector tray, where individual connectors can be
 * switched off or focused.
 *
 * Renders nothing when no connector is active FOR THIS CHAT (nothing is
 * being sent) — globally enabled servers this conversation opted out of
 * don't count. The connectors list then remains reachable through the `+`
 * menu.
 */
export const ConnectorActivityBadge: React.FC = () => {
  const t = useTranslations('connectorPin');
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const m365ToolsUserEnabled = useSettingsStore((s) => s.m365ToolsUserEnabled);
  const { toolsEnabled: m365ToolsFlagOn } = useM365Enabled();
  const trayOpen = useChatInputStore((s) => s.connectorPinTrayOpen);
  const setTrayOpen = useChatInputStore((s) => s.setConnectorPinTrayOpen);
  const { selectedConversation } = useConversations();

  // The builtin M365 toolset counts as active under the same gates the send
  // path uses (flag + connected + global toggle + not per-chat disabled).
  const m365Active =
    m365ToolsFlagOn &&
    m365Connected &&
    m365ToolsUserEnabled &&
    !selectedConversation?.disabledMcpServerIds?.includes(
      M365_BUILTIN_SERVER_ID,
    );
  const active: { id: string; name: string }[] = [
    ...mcpServers.filter(
      (s) =>
        s.enabled &&
        !(s.authMode === 'oauth' && s.oauth?.needsReauth) &&
        !selectedConversation?.disabledMcpServerIds?.includes(s.id),
    ),
    ...(m365Active
      ? [{ id: M365_BUILTIN_SERVER_ID, name: M365_BUILTIN_SERVER_LABEL }]
      : []),
  ];
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
    <CapabilityBubble
      icon={<IconPlugConnected size={14} className="text-blue-500" />}
      label={label}
      title={t('badgeTooltip')}
      ariaExpanded={trayOpen}
      onClick={() => setTrayOpen(!trayOpen)}
    />
  );
};
