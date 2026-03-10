'use client';

import { IconKeyboard } from '@tabler/icons-react';
import { useMemo } from 'react';

import { useTranslations } from 'next-intl';

import Modal from '@/components/UI/Modal';

import {
  SHORTCUT_CATEGORY_ORDER,
  formatShortcut,
  getShortcutsByCategory,
} from '@/lib/constants/keyboardShortcuts';

interface KeyboardShortcutsModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
}

/**
 * Modal component that displays all available keyboard shortcuts.
 * Shortcuts are grouped by category and show platform-appropriate key names.
 */
export function KeyboardShortcutsModal({
  isOpen,
  onClose,
}: KeyboardShortcutsModalProps) {
  const t = useTranslations();

  // Group shortcuts by category
  const groupedShortcuts = useMemo(() => getShortcutsByCategory(), []);

  // Sort categories according to defined order
  const sortedCategories = useMemo(() => {
    return SHORTCUT_CATEGORY_ORDER.filter(
      (category) => groupedShortcuts[category]?.length > 0,
    );
  }, [groupedShortcuts]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('shortcuts.title')}
      icon={
        <IconKeyboard
          size={24}
          className="text-neutral-600 dark:text-neutral-400"
        />
      }
      size="md"
    >
      <div className="max-h-[60vh] overflow-y-auto">
        {sortedCategories.map((categoryKey) => (
          <div key={categoryKey} className="mb-6 last:mb-0">
            <h3 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider mb-3">
              {t(categoryKey)}
            </h3>
            <div className="space-y-2">
              {groupedShortcuts[categoryKey].map((shortcut) => (
                <div
                  key={shortcut.id}
                  className="flex items-center justify-between py-2"
                >
                  <span className="text-neutral-900 dark:text-neutral-100">
                    {t(shortcut.labelKey)}
                  </span>
                  <kbd className="px-2 py-1 text-sm font-mono bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 rounded border border-neutral-200 dark:border-neutral-700">
                    {formatShortcut(shortcut)}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700 text-center">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('shortcuts.pressEscapeToClose')}
        </p>
      </div>
    </Modal>
  );
}
