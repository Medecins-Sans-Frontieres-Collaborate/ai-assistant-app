'use client';

import { FC } from 'react';

export interface AdminTab {
  id: string;
  label: string;
}

interface AdminTabsProps {
  tabs: AdminTab[];
  activeTab: string;
  onChange: (id: string) => void;
  /** Namespaces the generated ids so two tab strips can coexist on a page. */
  idPrefix: string;
  ariaLabel: string;
}

/**
 * The tab strip for admin sub-navigation, with the ARIA contract the
 * hand-rolled strips were missing.
 *
 * `border-b-2` sits on the BASE, not just the active tab: with it only on the
 * active one, every click changed the element's height and nudged the row 2px.
 *
 * Labels are passed in already translated — ids can't double as labels across
 * 53 locales.
 *
 * Deliberately NOT components/UI/TabNavigation.tsx: that positions a sliding
 * indicator from a per-tab width defaulting to 110px, which clips longer
 * labels in other locales.
 *
 * The CALLER is responsible for wrapping each body in
 * `role="tabpanel"` with `id={`${idPrefix}-panel-${id}`}` and
 * `aria-labelledby={`${idPrefix}-tab-${id}`}`.
 */
export const AdminTabs: FC<AdminTabsProps> = ({
  tabs,
  activeTab,
  onChange,
  idPrefix,
  ariaLabel,
}) => (
  <div
    role="tablist"
    aria-label={ariaLabel}
    className="mb-6 flex gap-1 border-b border-gray-200 dark:border-gray-700"
  >
    {tabs.map((tab) => {
      const isActive = tab.id === activeTab;
      return (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-selected={isActive}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
            isActive
              ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
              : 'border-transparent text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white'
          }`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      );
    })}
  </div>
);
