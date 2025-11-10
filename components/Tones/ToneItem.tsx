import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconDownload,
  IconEdit,
  IconFolder,
  IconTrash,
  IconUsersGroup,
} from '@tabler/icons-react';
import { FC, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { FolderInterface } from '@/types/folder';
import { Tone } from '@/types/tone';

interface ToneItemProps {
  tone: Tone;
  folders: FolderInterface[];
  isSelected?: boolean;
  isExpanded?: boolean;
  onClick?: () => void;
  onEdit: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onMoveToFolder: (toneId: string, folderId: string | null) => void;
  onExport?: () => void;
}

export const ToneItem: FC<ToneItemProps> = ({
  tone,
  folders,
  isSelected = false,
  isExpanded = false,
  onClick,
  onEdit,
  onDelete,
  onMoveToFolder,
  onExport,
}) => {
  const t = useTranslations();
  const [showMenu, setShowMenu] = useState(false);
  const [showFolderSubmenu, setShowFolderSubmenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
        setShowFolderSubmenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showMenu]);

  return (
    <div
      onClick={onClick}
      className={`group relative flex items-center transition-all duration-200 ease-in-out rounded-lg cursor-pointer ${
        isSelected
          ? 'bg-blue-50 dark:bg-blue-900/20 ring-2 ring-blue-500 dark:ring-blue-400 ring-inset'
          : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
      } ${isExpanded ? 'gap-3 px-3 py-3.5' : 'gap-2 px-2 py-2.5'}`}
    >
      <div className="flex-1 min-w-0">
        <div
          className={`font-medium text-neutral-900 dark:text-neutral-100 truncate ${isExpanded ? 'text-lg' : 'text-base'}`}
        >
          {tone.name}
        </div>
        {tone.description && (
          <div
            className={`text-neutral-500 dark:text-neutral-400 truncate mt-0.5 ${isExpanded ? 'text-base' : 'text-sm'}`}
          >
            {tone.description}
          </div>
        )}
        {(tone.templateName || (tone.tags && tone.tags.length > 0)) && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {tone.templateName && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 font-medium"
                title={`From template: ${tone.templateName}`}
              >
                <IconUsersGroup size={12} />
                {tone.templateName}
              </span>
            )}
            {tone.tags &&
              tone.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                >
                  {tag}
                </span>
              ))}
          </div>
        )}
      </div>

      <div className="shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          className="rounded p-1.5 hover:bg-neutral-200 dark:hover:bg-neutral-700"
          onClick={onEdit}
          title={t('Edit')}
        >
          <IconEdit
            size={isExpanded ? 18 : 16}
            className="text-neutral-600 dark:text-neutral-400"
          />
        </button>

        <div className="relative" ref={menuRef}>
          <button
            className="rounded p-1.5 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
            title={t('Options')}
          >
            <IconDots
              size={isExpanded ? 18 : 16}
              className="text-neutral-600 dark:text-neutral-400"
            />
          </button>

          {showMenu && (
            <div className="absolute right-0 mt-1 w-52 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#171717] shadow-lg z-50">
              <div>
                <button
                  className="flex items-center w-full px-3 py-2.5 text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center justify-between"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFolderSubmenu(!showFolderSubmenu);
                  }}
                >
                  <span className="flex items-center gap-2">
                    <IconFolder
                      size={16}
                      className="text-neutral-600 dark:text-neutral-400"
                    />
                    {t('Move to folder')}
                  </span>
                  {showFolderSubmenu ? (
                    <IconChevronDown
                      size={16}
                      className="text-neutral-600 dark:text-neutral-400"
                    />
                  ) : (
                    <IconChevronRight
                      size={16}
                      className="text-neutral-600 dark:text-neutral-400"
                    />
                  )}
                </button>

                {/* Folder submenu - inline expansion */}
                {showFolderSubmenu && (
                  <div className="pl-4 mt-1">
                    <button
                      className="w-full text-left px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center justify-between"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMoveToFolder(tone.id, null);
                        setShowMenu(false);
                        setShowFolderSubmenu(false);
                      }}
                    >
                      {t('No folder')}
                      {!tone.folderId && (
                        <IconCheck size={14} className="shrink-0" />
                      )}
                    </button>
                    {folders.map((folder) => (
                      <button
                        key={folder.id}
                        className="w-full text-left px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center justify-between"
                        onClick={(e) => {
                          e.stopPropagation();
                          onMoveToFolder(tone.id, folder.id);
                          setShowMenu(false);
                          setShowFolderSubmenu(false);
                        }}
                      >
                        <span className="truncate">{folder.name}</span>
                        {tone.folderId === folder.id && (
                          <IconCheck size={14} className="shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {onExport && (
                <button
                  className="flex items-center w-full px-3 py-2.5 text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExport();
                    setShowMenu(false);
                  }}
                >
                  <IconDownload size={16} className="mr-2" />
                  {t('Export')}
                </button>
              )}

              <button
                className="flex items-center w-full px-3 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 last:rounded-b-lg"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(e);
                  setShowMenu(false);
                }}
              >
                <IconTrash size={16} className="mr-2" />
                {t('Delete')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
