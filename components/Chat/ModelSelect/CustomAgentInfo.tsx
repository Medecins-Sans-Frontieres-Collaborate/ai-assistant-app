import { IconDownload, IconEdit, IconTrash } from '@tabler/icons-react';
import React, { FC, useState } from 'react';

import { exportSingleCustomAgent } from '@/lib/utils/app/export/customAgentExport';

import { OpenAIModels } from '@/types/openai';

import { CustomAgent } from '@/client/stores/settingsStore';

interface CustomAgentInfoProps {
  agent: CustomAgent;
  onEdit: (agent: CustomAgent) => void;
  onDelete: (agentId: string) => void;
}

export const CustomAgentInfo: FC<CustomAgentInfoProps> = ({
  agent,
  onEdit,
  onDelete,
}) => {
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const baseModel = OpenAIModels[agent.baseModelId];

  const handleDelete = () => {
    if (deleteConfirm) {
      onDelete(agent.id);
      setDeleteConfirm(false);
    } else {
      setDeleteConfirm(true);
      setTimeout(() => setDeleteConfirm(false), 3000);
    }
  };

  const handleExport = () => {
    exportSingleCustomAgent(agent);
  };

  return (
    <div className="space-y-4">
      {/* Agent Details */}
      <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-3">
          Agent Details
        </h4>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">Agent ID:</span>
            <code className="bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded text-xs text-gray-900 dark:text-gray-100">
              {agent.agentId}
            </code>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">
              Base Model:
            </span>
            <span className="text-gray-900 dark:text-white">
              {baseModel?.name || 'Unknown'}
            </span>
          </div>
          {agent.description && (
            <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
              <span className="text-gray-500 dark:text-gray-400 block mb-1">
                Description:
              </span>
              <p className="text-gray-700 dark:text-gray-300 text-xs">
                {agent.description}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleExport}
          className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        >
          <IconDownload size={16} />
          Export
        </button>
        <button
          onClick={() => onEdit(agent)}
          className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 text-sm bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-lg hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
        >
          <IconEdit size={16} />
          Edit
        </button>
        <button
          onClick={handleDelete}
          className={`flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
            deleteConfirm
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/50'
          }`}
        >
          <IconTrash size={16} />
          {deleteConfirm ? 'Confirm' : 'Delete'}
        </button>
      </div>
    </div>
  );
};
