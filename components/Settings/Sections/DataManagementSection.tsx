import {
  IconDatabase,
  IconFileExport,
  IconUsersGroup,
} from '@tabler/icons-react';
import { FC, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';

import { getStorageUsage } from '@/lib/utils/app/storage/storageMonitor';
import { formatBytes } from '@/lib/utils/app/storage/storageUtils';

import { SidebarButton } from '../../Sidebar/SidebarButton';
import { ClearConversations } from '../ClearConversations';
import { Import } from '../Import';
import { TeamTemplateModal } from '../TeamTemplateModal';

interface StorageData {
  currentUsage: number;
  maxUsage: number;
  percentUsed: number;
}

interface DataManagementSectionProps {
  handleClearConversations: () => void;
  handleImportConversations: (data: any) => void;
  handleExportData: () => void;
  handleReset: () => void;
  onClose: () => void;
  checkStorage: () => void;
}

export const DataManagementSection: FC<DataManagementSectionProps> = ({
  handleClearConversations,
  handleImportConversations,
  handleExportData,
  handleReset,
  onClose,
  checkStorage,
}) => {
  const { conversations } = useConversations();
  const t = useTranslations();
  const [storageData, setStorageData] = useState<StorageData>(() =>
    getStorageUsage(),
  );
  const [isTeamTemplateModalOpen, setIsTeamTemplateModalOpen] = useState(false);

  // Update storage data when component mounts
  useEffect(() => {
    const data = getStorageUsage();
    setStorageData(data);
    checkStorage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <IconDatabase size={24} className="text-black dark:text-white" />
        <h2 className="text-xl font-bold text-black dark:text-white">
          {t('settings.Data Management')}
        </h2>
      </div>

      <div className="space-y-6">
        {/* Storage Usage Information */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h3 className="text-md font-bold mb-4 text-black dark:text-white border-b border-gray-200 dark:border-gray-700 pb-2">
            {t('settings.Storage Information')}
          </h3>
          <div className="space-y-3">
            <div className="text-sm text-black dark:text-neutral-300">
              <span className="font-medium">
                {t('settings.Storage Usage')}:
              </span>{' '}
              {formatBytes(storageData.currentUsage)} /{' '}
              {formatBytes(storageData.maxUsage)} (
              {storageData.percentUsed.toFixed(1)}%)
            </div>

            <div className="w-full bg-gray-300 dark:bg-gray-700 rounded-full h-2.5">
              <div
                className={`h-2.5 rounded-full transition-all ${
                  storageData.percentUsed > 85
                    ? 'bg-red-600'
                    : storageData.percentUsed > 70
                      ? 'bg-yellow-500'
                      : 'bg-green-500'
                }`}
                style={{ width: `${Math.min(storageData.percentUsed, 100)}%` }}
              ></div>
            </div>

            <div className="text-xs text-gray-600 dark:text-gray-400">
              {storageData.percentUsed > 85 ? (
                <span className="text-red-600 dark:text-red-400 font-medium">
                  {t('settings.storageAlmostFull')}
                </span>
              ) : storageData.percentUsed > 70 ? (
                <span className="text-yellow-600 dark:text-yellow-400 font-medium">
                  {t('settings.storageUsageHigh')}
                </span>
              ) : (
                <span>{t('settings.storageUsageNormal')}</span>
              )}
            </div>
          </div>
        </div>

        {/* Backup & Restore */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h3 className="text-md font-bold mb-4 text-black dark:text-white border-b border-gray-200 dark:border-gray-700 pb-2">
            {t('settings.Backup & Restore')}
          </h3>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
            {t('settings.backupDescription')}
          </p>
          <div className="flex flex-col space-y-2">
            <SidebarButton
              text={t('settings.Export Full Backup')}
              icon={<IconFileExport size={18} />}
              onClick={() => handleExportData()}
            />
            <Import
              onImport={(data) => {
                handleImportConversations(data);
                setTimeout(() => {
                  setStorageData(getStorageUsage());
                  checkStorage();
                }, 100);
              }}
            />
          </div>
        </div>

        {/* Clear Conversations */}
        {conversations && conversations.length > 0 && (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
            <h3 className="text-md font-bold mb-4 text-black dark:text-white border-b border-gray-200 dark:border-gray-700 pb-2">
              {t('settings.Clear Data')}
            </h3>
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
              {t('settings.clearDataWarning')}
            </p>
            <ClearConversations
              onClearConversations={() => {
                handleClearConversations();
                setTimeout(() => {
                  setStorageData(getStorageUsage());
                  checkStorage();
                }, 100);
              }}
            />
          </div>
        )}

        {/* Team Templates Section */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <div className="flex items-center mb-4 border-b border-gray-200 dark:border-gray-700 pb-2">
            <h3 className="text-md font-bold text-black dark:text-white">
              {t('settings.Team Templates')}
            </h3>
            <span className="ml-2 px-2 py-0.5 text-xs font-semibold bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-400 rounded">
              {t('settings.Experimental')}
            </span>
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
            {t('settings.teamTemplatesDescription')}
          </p>
          <SidebarButton
            text={t('settings.Manage Team Templates')}
            icon={<IconUsersGroup size={18} />}
            onClick={() => setIsTeamTemplateModalOpen(true)}
          />
        </div>
      </div>

      {/* Team Template Modal */}
      <TeamTemplateModal
        isOpen={isTeamTemplateModalOpen}
        onClose={() => setIsTeamTemplateModalOpen(false)}
      />
    </div>
  );
};
