'use client';

import { IconPencil, IconPlugConnected, IconTrash } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useMcpTools } from '@/client/hooks/settings/useMcpTools';

import { ToolCountDisclosure } from './ToolCountDisclosure';

import {
  McpServerConfig,
  useSettingsStore,
} from '@/client/stores/settingsStore';

interface McpServerRowProps {
  server: McpServerConfig;
  onEdit: (server: McpServerConfig) => void;
  onDelete: (id: string) => void;
}

/** One arbitrary (non-catalog) MCP server in the Connectors list. */
export const McpServerRow: FC<McpServerRowProps> = ({
  server,
  onEdit,
  onDelete,
}) => {
  const t = useTranslations('connectors');
  const updateMcpServer = useSettingsStore((s) => s.updateMcpServer);
  const { tools, isLoadingTools } = useMcpTools(server);

  return (
    <div className="flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <IconPlugConnected
        size={24}
        className="mt-0.5 shrink-0 text-black dark:text-white"
      />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-black dark:text-white">
          {server.name}
        </span>
        <p className="mt-0.5 break-all text-xs text-gray-500 dark:text-gray-400">
          {server.url}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-4">
          {!isLoadingTools && (
            <ToolCountDisclosure serverLabel={server.name} tools={tools} />
          )}
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-gray-600 dark:accent-gray-400"
              checked={server.enabled}
              onChange={(e) =>
                updateMcpServer(server.id, { enabled: e.target.checked })
              }
            />
            <span className="text-sm text-black dark:text-gray-200">
              {t('enableServer')}
            </span>
          </label>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onEdit(server)}
          aria-label={t('editServer')}
          className="rounded-lg p-1.5 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <IconPencil size={16} />
        </button>
        <button
          type="button"
          onClick={() => onDelete(server.id)}
          aria-label={t('disconnect')}
          className="rounded-lg p-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
        >
          <IconTrash size={16} />
        </button>
      </div>
    </div>
  );
};
