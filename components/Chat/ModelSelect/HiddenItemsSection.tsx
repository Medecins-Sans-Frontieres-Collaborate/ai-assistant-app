'use client';

import {
  IconArrowBackUp,
  IconChevronDown,
  IconChevronRight,
} from '@tabler/icons-react';
import { FC, ReactNode, useState } from 'react';

import { useTranslations } from 'next-intl';

export interface HiddenItem {
  id: string;
  name: string;
  icon?: ReactNode;
}

interface HiddenItemsSectionProps {
  items: HiddenItem[];
  onRestore: (id: string) => void;
}

/**
 * Collapsible "Hidden (N)" group rendered at the bottom of the model and agent
 * lists. Lets the user restore anything they previously hid. Renders nothing
 * when there is nothing hidden, so it never adds chrome to a clean list.
 */
export const HiddenItemsSection: FC<HiddenItemsSectionProps> = ({
  items,
  onRestore,
}) => {
  const t = useTranslations('modelSelect');
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
      >
        {expanded ? (
          <IconChevronDown size={12} />
        ) : (
          <IconChevronRight size={12} />
        )}
        <span>{t('hidden.title', { count: items.length })}</span>
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/50"
            >
              <div className="flex items-center gap-2 min-w-0">
                {item.icon}
                <span className="text-sm text-gray-600 dark:text-gray-300 truncate">
                  {item.name}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onRestore(item.id)}
                className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
              >
                <IconArrowBackUp size={14} />
                <span>{t('hidden.restore')}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
