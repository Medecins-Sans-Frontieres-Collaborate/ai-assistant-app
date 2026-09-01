'use client';

import { IconFileImport, IconSearch } from '@tabler/icons-react';
import { FC, useEffect, useMemo, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { foreignConversationId } from '@/lib/utils/app/export/foreignImport/toConversation';
import {
  ForeignConversation,
  ForeignImportDetection,
} from '@/lib/utils/app/export/foreignImport/types';

import Modal from '@/components/UI/Modal';

interface Props {
  isOpen: boolean;
  detection: ForeignImportDetection | null;
  /** Ids already in the store — matching rows start unchecked and badged. */
  existingIds: Set<string>;
  onClose: () => void;
  onImport: (
    selected: ForeignConversation[],
    options: { folderName: string | null },
  ) => void;
}

const sourceLabelKey = (source: ForeignImportDetection['source']) =>
  source === 'chatgpt' ? 'sourceChatGpt' : 'sourceClaude';

/**
 * Picker shown after a ChatGPT / Claude export is recognised. A data export
 * can hold hundreds of threads and the store is localStorage-backed, so the
 * user chooses what to bring over instead of importing everything.
 */
export const ForeignConversationImportModal: FC<Props> = ({
  isOpen,
  detection,
  existingIds,
  onClose,
  onImport,
}) => {
  const t = useTranslations('conversationImport');
  const locale = useLocale();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [placeInFolder, setPlaceInFolder] = useState(true);
  const [folderName, setFolderName] = useState('');

  const source = detection?.source ?? 'chatgpt';
  const sourceLabel = t(sourceLabelKey(source));
  const items = useMemo(() => detection?.conversations ?? [], [detection]);

  const appIdOf = (c: ForeignConversation) =>
    foreignConversationId(c.source, c.sourceId);

  // Reset selection whenever a new detection arrives: everything not yet
  // imported starts checked, previously imported rows start unchecked.
  useEffect(() => {
    if (!detection) return;
    setSelected(
      new Set(
        detection.conversations
          .filter((c) => !existingIds.has(appIdOf(c)))
          .map((c) => c.sourceId),
      ),
    );
    setFilter('');
    setPlaceInFolder(true);
    setFolderName(
      t('defaultFolderName', { source: t(sourceLabelKey(detection.source)) }),
    );
    // existingIds is intentionally excluded: a store update while the picker
    // is open must not wipe the user's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detection, t]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => (c.title || '').toLowerCase().includes(q));
  }, [filter, items]);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
    [locale],
  );

  const toggle = (sourceId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  const selectVisible = (on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of visible) {
        if (on) next.add(c.sourceId);
        else next.delete(c.sourceId);
      }
      return next;
    });
  };

  const selectedItems = items.filter((c) => selected.has(c.sourceId));
  const allVisibleSelected =
    visible.length > 0 && visible.every((c) => selected.has(c.sourceId));

  const handleImport = () => {
    if (selectedItems.length === 0) return;
    onImport(selectedItems, {
      folderName: placeInFolder ? folderName.trim() || null : null,
    });
  };

  if (!detection) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('title')}
      icon={<IconFileImport size={22} />}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-600 dark:text-gray-400">
            {t('selectedCount', {
              selected: selectedItems.length,
              total: items.length,
            })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={selectedItems.length === 0}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('importButton', { count: selectedItems.length })}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t('detected', { count: items.length, source: sourceLabel })}
          {detection.skipped > 0 && (
            <>
              {' '}
              <span className="text-amber-700 dark:text-amber-400">
                {t('skipped', { count: detection.skipped })}
              </span>
            </>
          )}
        </p>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          {t('textOnly')}
        </p>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <IconSearch
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              className="w-full pl-7 pr-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
          </div>
          <button
            type="button"
            onClick={() => selectVisible(!allVisibleSelected)}
            disabled={visible.length === 0}
            className="text-xs px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            {allVisibleSelected ? t('deselectAll') : t('selectAll')}
          </button>
        </div>

        <ul
          aria-label={t('listLabel')}
          className="max-h-[45vh] overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-100 dark:divide-gray-800"
        >
          {visible.length === 0 && (
            <li className="p-3 text-sm text-gray-500 dark:text-gray-400">
              {t('noMatches')}
            </li>
          )}
          {visible.map((c) => {
            const already = existingIds.has(appIdOf(c));
            const checked = selected.has(c.sourceId);
            const when = c.updatedAt ?? c.createdAt;
            return (
              <li key={c.sourceId}>
                <label className="flex items-start gap-3 p-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    onChange={() => toggle(c.sourceId)}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-sm text-gray-900 dark:text-gray-100 truncate">
                        {c.title || t('untitled')}
                      </span>
                      {already && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 shrink-0">
                          {t('alreadyImported')}
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {when ? `${dateFormatter.format(new Date(when))} · ` : ''}
                      {t('turnCount', { count: c.turns.length })}
                      {c.droppedParts > 0 &&
                        ` · ${t('droppedParts', { count: c.droppedParts })}`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-2">
          <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200 cursor-pointer">
            <input
              type="checkbox"
              checked={placeInFolder}
              onChange={(e) => setPlaceInFolder(e.target.checked)}
            />
            {t('placeInFolder')}
          </label>
          {placeInFolder && (
            <input
              type="text"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              aria-label={t('folderName')}
              placeholder={t('folderName')}
              className="w-full px-2 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
          )}
        </div>
      </div>
    </Modal>
  );
};

export default ForeignConversationImportModal;
