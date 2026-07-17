'use client';

import { IconPlugConnected, IconPlus } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useCallback, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { CuratedConnectorRow } from '../Connectors/CuratedConnectorRow';
import { McpServerForm } from '../Connectors/McpServerForm';
import { McpServerRow } from '../Connectors/McpServerRow';

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

  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<
    McpServerConfig | undefined
  >();

  const arbitraryServers = mcpServers.filter((s) => !s.catalogKey);

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

      {/* Curated catalog */}
      <div className="space-y-3">
        {Object.values(MCP_CATALOG).map((entry) => (
          <CuratedConnectorRow
            key={entry.key}
            entry={entry}
            config={mcpServers.find((s) => s.catalogKey === entry.key)}
          />
        ))}
      </div>

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
