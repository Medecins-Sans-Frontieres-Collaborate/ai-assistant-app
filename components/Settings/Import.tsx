import { IconFileImport } from '@tabler/icons-react';
import { FC } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { SupportedExportFormats } from '@/types/export';

import { SidebarButton } from '../Sidebar/SidebarButton';

interface Props {
  onImport: (data: SupportedExportFormats) => void;
}

export const Import: FC<Props> = ({ onImport }) => {
  const t = useTranslations();
  return (
    <>
      <input
        id="import-file"
        className="sr-only"
        tabIndex={-1}
        type="file"
        accept=".json"
        onChange={(e) => {
          if (!e.target.files?.length) return;

          const file = e.target.files[0];
          const reader = new FileReader();
          reader.onload = (e) => {
            try {
              const json = JSON.parse(e.target?.result as string);
              onImport(json);
            } catch (error) {
              toast.error(t('importBackupParseError'));
            }
          };
          reader.readAsText(file);
        }}
      />

      <SidebarButton
        text={t('settings.Import Backup')}
        icon={<IconFileImport size={18} />}
        onClick={() => {
          const importFile = document.querySelector(
            '#import-file',
          ) as HTMLInputElement;
          if (importFile) {
            importFile.click();
          }
        }}
      />
    </>
  );
};
