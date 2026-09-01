import { IconFileImport } from '@tabler/icons-react';
import { FC } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { isZipArchive } from '@/lib/utils/app/export/foreignImport/detect';

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
        onChange={async (e) => {
          if (!e.target.files?.length) return;

          const input = e.target;
          const file = e.target.files[0];
          try {
            // ChatGPT / Claude exports are zips; we don't unpack archives.
            if (await isZipArchive(file)) {
              toast.error(t('conversationImport.zipRejected'), {
                duration: 8000,
              });
              return;
            }
            const json = JSON.parse(await file.text());
            onImport(json);
          } catch (error) {
            toast.error(t('importBackupParseError'));
          } finally {
            // Allow re-selecting the same file after a failed attempt.
            input.value = '';
          }
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
