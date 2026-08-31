'use client';

import { IconFolder, IconFolderOff } from '@tabler/icons-react';
import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { FolderInterface } from '@/types/folder';

import { SearchableListPicker } from '@/components/UI/SearchableListPicker';

/** Below this many folders the picker is a plain menu — no search box. */
export const FOLDER_PICKER_SEARCH_THRESHOLD = 8;

export interface FolderPickerProps {
  triggerRef: React.RefObject<HTMLElement | null>;
  isOpen: boolean;
  onClose: () => void;
  folders: FolderInterface[];
  /** The item's current folder (null = top level). */
  value: string | null;
  /** `null` = move to top level ("No folder"). */
  onSelect: (folderId: string | null) => void;
  /**
   * When provided, typing a name that matches no folder offers
   * "New folder …"; the caller creates the folder and moves the item.
   */
  onCreateFolder?: (name: string) => void;
  /** Hide the "No folder" row (e.g. when the item is already top level). */
  hideClearOption?: boolean;
}

/**
 * "Move to folder" chooser shared by conversations, prompts and tones.
 * Alphabetical, searchable past FOLDER_PICKER_SEARCH_THRESHOLD entries,
 * keyboard navigable, and able to create a folder inline.
 */
export const FolderPicker: FC<FolderPickerProps> = ({
  triggerRef,
  isOpen,
  onClose,
  folders,
  value,
  onSelect,
  onCreateFolder,
  hideClearOption = false,
}) => {
  const t = useTranslations();

  const options = useMemo(
    () =>
      [...folders]
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        )
        .map((folder) => ({
          id: folder.id,
          label: folder.name,
          icon: (
            <IconFolder
              size={14}
              aria-hidden
              className="shrink-0 text-gray-500 dark:text-gray-400"
            />
          ),
        })),
    [folders],
  );

  return (
    <SearchableListPicker
      triggerRef={triggerRef}
      isOpen={isOpen}
      onClose={onClose}
      options={options}
      value={value}
      onSelect={onSelect}
      clearOption={
        hideClearOption
          ? null
          : {
              label: t('No folder'),
              icon: (
                <IconFolderOff
                  size={14}
                  aria-hidden
                  className="shrink-0 text-gray-500 dark:text-gray-400"
                />
              ),
            }
      }
      searchPlaceholder={t('folderPicker.searchPlaceholder')}
      ariaLabel={t('folderPicker.ariaLabel')}
      noResultsLabel={t('folderPicker.noResults')}
      clearSearchLabel={t('common.clearSearch')}
      searchThreshold={FOLDER_PICKER_SEARCH_THRESHOLD}
      onCreateOption={onCreateFolder}
      createLabel={(name) => t('folderPicker.createFolder', { name })}
    />
  );
};
