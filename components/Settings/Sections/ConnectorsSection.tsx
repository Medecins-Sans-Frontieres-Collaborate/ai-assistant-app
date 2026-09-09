'use client';

import { IconPlugConnected, IconPlus } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useCallback, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useAvailableConnectors } from '@/client/hooks/settings/useAvailableConnectors';
import { useMcpOauthAvailability } from '@/client/hooks/settings/useMcpOauthAvailability';

import { BuiltinM365Row } from '@/components/Settings/Connectors/BuiltinM365Row';

import { AdminConnectorRow } from '../Connectors/AdminConnectorRow';
import { ConnectorBrowser } from '../Connectors/ConnectorBrowser';
import { CuratedConnectorRow } from '../Connectors/CuratedConnectorRow';
import { McpServerForm } from '../Connectors/McpServerForm';
import { McpServerRow } from '../Connectors/McpServerRow';
import { ToolApprovalRulesManager } from '../Connectors/ToolApprovalRulesManager';

import {
  McpServerConfig,
  useSettingsStore,
} from '@/client/stores/settingsStore';
import { MCP_CATALOG } from '@/config/mcpCatalog';

/**
 * "Connectors" settings section: curated MCP catalog (GitHub, Asana) plus —
 * behind the LaunchDarkly `mcpArbitraryServers` flag AND a user opt-in
 * toggle — arbitrary MCP servers.
 */
export const ConnectorsSection: FC = () => {
  const t = useTranslations('connectors');
  const tCommon = useTranslations('common');

  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const allowArbitrary = useSettingsStore((s) => s.allowArbitraryMcpServers);
  const setAllowArbitrary = useSettingsStore(
    (s) => s.setAllowArbitraryMcpServers,
  );
  const addMcpServer = useSettingsStore((s) => s.addMcpServer);
  const updateMcpServer = useSettingsStore((s) => s.updateMcpServer);
  const deleteMcpServer = useSettingsStore((s) => s.deleteMcpServer);

  // Fail-closed: arbitrary servers are the exfiltration surface, so an
  // unserved/absent flag (or an LD outage) must degrade to OFF — unlike the
  // codebase's usual `!== false` convention.
  const { mcpArbitraryServers } = useFlags();
  const arbitraryFlagOn = mcpArbitraryServers === true;

  // Fetched once here rather than per row, so N connectors share one request.
  const { isOauthAppAvailable } = useMcpOauthAvailability();
  // Admin-authored connectors this user is entitled to (server-filtered).
  const { connectors: adminConnectors } = useAvailableConnectors();

  // Which connector the user asked to add and is now configuring. Cleared
  // when it lands in the store (it leaves the browser) or on dismiss.
  const [configuringKey, setConfiguringKey] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<
    McpServerConfig | undefined
  >();

  // Connectors are server-resolved like catalog entries, so they must be
  // excluded here too — otherwise they would render a second time as
  // user-defined servers with an editable URL.
  const arbitraryServers = mcpServers.filter(
    (s) => !s.catalogKey && !s.connectorId,
  );

  // A connector is "connected" once it has a saved config, which is also
  // what moves it out of the browser list — so the add flow needs no
  // completion callback: the store update relocates the row by itself.
  const connectedKeys = useMemo(
    () =>
      new Set(
        mcpServers
          .map((s) => s.catalogKey ?? s.connectorId)
          .filter((key): key is string => key !== undefined),
      ),
    [mcpServers],
  );
  const connectedCatalog = Object.values(MCP_CATALOG).filter((entry) =>
    connectedKeys.has(entry.key),
  );
  const connectedAdmin = adminConnectors.filter((c) => connectedKeys.has(c.id));

  const handleDelete = useCallback(
    (id: string) => {
      const server = mcpServers.find((s) => s.id === id);
      if (!server) return;
      deleteMcpServer(id);
      // Undo restores the captured object — token included, so the
      // connection comes back working.
      toast(
        (toastInstance) => (
          <div className="flex items-center gap-3">
            <span>{t('disconnectedToast', { name: server.name })}</span>
            <button
              onClick={() => {
                addMcpServer(server);
                toast.dismiss(toastInstance.id);
              }}
              className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
            >
              {tCommon('undo')}
            </button>
          </div>
        ),
        { duration: 8000 },
      );
    },
    [mcpServers, deleteMcpServer, addMcpServer, t, tCommon],
  );

  const handleSave = useCallback(
    (server: McpServerConfig) => {
      if (editingServer) {
        updateMcpServer(server.id, server);
      } else {
        addMcpServer(server);
      }
      setEditingServer(undefined);
      setShowForm(false);
    },
    [editingServer, addMcpServer, updateMcpServer],
  );

  return (
    <div className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <IconPlugConnected size={24} className="text-black dark:text-white" />
        <h2 className="text-xl font-bold text-black dark:text-white">
          {t('title')}
        </h2>
      </div>
      <p className="mb-1 text-sm text-gray-600 dark:text-gray-400">
        {t('description')}
      </p>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {t('localOnlyNote')}
      </p>

      {/* Built-in first-party toolsets render alongside connectors — same
          controls, no URL/auth editing. */}
      <BuiltinM365Row />

      {/* Connected first: what the user already has is the thing they came
          back to change. Everything on offer lives below, behind an add. */}
      {connectedCatalog.length + connectedAdmin.length > 0 && (
        <div>
          <h3 className="mb-2 text-base font-semibold text-black dark:text-white">
            {t('yourConnectorsTitle')}
          </h3>
          <div className="space-y-3">
            {connectedCatalog.map((entry) => (
              <CuratedConnectorRow
                key={entry.key}
                entry={entry}
                config={mcpServers.find((s) => s.catalogKey === entry.key)}
                oauthAppAvailable={isOauthAppAvailable(entry.key)}
              />
            ))}
            {connectedAdmin.map((connector) => (
              <AdminConnectorRow
                key={connector.id}
                connector={connector}
                config={mcpServers.find((s) => s.connectorId === connector.id)}
              />
            ))}
          </div>
        </div>
      )}

      <ConnectorBrowser
        catalogEntries={Object.values(MCP_CATALOG)}
        adminConnectors={adminConnectors}
        connectedKeys={connectedKeys}
        configuringKey={configuringKey}
        onAdd={setConfiguringKey}
        renderConfiguring={(key) => {
          const catalogEntry = MCP_CATALOG[key];
          if (catalogEntry) {
            return (
              <CuratedConnectorRow
                entry={catalogEntry}
                oauthAppAvailable={isOauthAppAvailable(key)}
                onDismiss={() => setConfiguringKey(null)}
              />
            );
          }
          const connector = adminConnectors.find((c) => c.id === key);
          return connector ? (
            <AdminConnectorRow
              connector={connector}
              onDismiss={() => setConfiguringKey(null)}
            />
          ) : null;
        }}
      />

      {/* Global tool approval policy — only meaningful once something is
          connected, but rules for not-yet-seen tools are the point, so it
          shows whenever ANY connector exists. */}
      {mcpServers.length > 0 && <ToolApprovalRulesManager />}

      {/* Arbitrary servers — only when the LD flag allows it at all */}
      {arbitraryFlagOn && (
        <div className="mt-8">
          <h3 className="mb-2 text-base font-semibold text-black dark:text-white">
            {t('arbitraryTitle')}
          </h3>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-gray-600 dark:accent-gray-400"
              checked={allowArbitrary}
              onChange={(e) => setAllowArbitrary(e.target.checked)}
            />
            <span>
              <span className="block text-sm text-black dark:text-gray-200">
                {t('arbitraryToggle')}
              </span>
              {/* Transparent consequences: what turning this on means. */}
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                {t('arbitraryWarning')}
              </span>
            </span>
          </label>

          {allowArbitrary && (
            <div className="mt-4 space-y-3">
              {arbitraryServers.map((server) => (
                <McpServerRow
                  key={server.id}
                  server={server}
                  onEdit={(s) => {
                    setEditingServer(s);
                    setShowForm(true);
                  }}
                  onDelete={handleDelete}
                />
              ))}
              <button
                type="button"
                onClick={() => {
                  setEditingServer(undefined);
                  setShowForm(true);
                }}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <IconPlus size={16} />
                {t('addServer')}
              </button>
            </div>
          )}
        </div>
      )}

      {showForm && (
        <McpServerForm
          onSave={handleSave}
          onClose={() => {
            setEditingServer(undefined);
            setShowForm(false);
          }}
          existingServer={editingServer}
        />
      )}
    </div>
  );
};
