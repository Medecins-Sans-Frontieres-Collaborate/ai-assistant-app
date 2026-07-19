'use client';

import { IconBuildingBank, IconPlus, IconSearch } from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { AvailableConnector } from '@/client/hooks/settings/useAvailableConnectors';

import { catalogIcon } from './catalogIcons';

import { McpCatalogEntry } from '@/config/mcpCatalog';

/** Above this many available entries the list earns a filter field. */
const FILTER_THRESHOLD = 6;

export interface BrowsableConnector {
  /** Stable key: catalog key, or connector id for admin-authored entries. */
  key: string;
  name: string;
  description: string;
  kind: 'catalog' | 'admin';
}

interface ConnectorBrowserProps {
  catalogEntries: McpCatalogEntry[];
  adminConnectors: AvailableConnector[];
  /** Keys already connected — filtered out; the browser only offers new ones. */
  connectedKeys: Set<string>;
  onAdd: (key: string) => void;
  /** Rendered in place of the compact row for the entry being configured. */
  renderConfiguring?: (key: string) => React.ReactNode;
  configuringKey: string | null;
}

/**
 * The "add a connector" list.
 *
 * Replaces the previous wall of fully-expanded catalog rows: with six curated
 * entries plus however many an admin has published, every connector shouting
 * its whole configuration UI at once made the section unreadable. Here each
 * available connector is one dense row — mark, name, one line of purpose,
 * Add — and only the entry the user actually asks for expands.
 *
 * Deliberately a LIST, not a card grid. A grid of identical icon+title+text
 * tiles is the reflex answer and it fails this product twice over: it reads
 * as marketing chrome in a working settings surface, and it breaks under the
 * long compounds and RTL of 33 locales far sooner than a row does.
 */
export const ConnectorBrowser: FC<ConnectorBrowserProps> = ({
  catalogEntries,
  adminConnectors,
  connectedKeys,
  onAdd,
  renderConfiguring,
  configuringKey,
}) => {
  const t = useTranslations('connectors');
  const [filter, setFilter] = useState('');

  const available = useMemo<BrowsableConnector[]>(() => {
    const catalog: BrowsableConnector[] = catalogEntries.map((entry) => ({
      key: entry.key,
      // Catalog names/descriptions are i18n keys; admin ones are typed data.
      name: t(`catalog.${entry.key}.name`),
      description: t(`catalog.${entry.key}.description`),
      kind: 'catalog',
    }));
    const admin: BrowsableConnector[] = adminConnectors.map((connector) => ({
      key: connector.id,
      name: connector.name,
      description: connector.description,
      kind: 'admin',
    }));
    return [...catalog, ...admin].filter(
      (entry) => !connectedKeys.has(entry.key),
    );
  }, [catalogEntries, adminConnectors, connectedKeys, t]);

  const showFilter = available.length > FILTER_THRESHOLD;
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? available.filter(
        (entry) =>
          entry.name.toLowerCase().includes(needle) ||
          entry.description.toLowerCase().includes(needle),
      )
    : available;

  // Everything already connected: the browser has nothing left to offer, and
  // an empty "Add a connector" heading would just be noise.
  if (available.length === 0 && configuringKey === null) return null;

  const catalogShown = shown.filter((entry) => entry.kind === 'catalog');
  const adminShown = shown.filter((entry) => entry.kind === 'admin');

  const renderRow = (entry: BrowsableConnector) => {
    if (configuringKey === entry.key && renderConfiguring) {
      return <div key={entry.key}>{renderConfiguring(entry.key)}</div>;
    }
    const Icon =
      entry.kind === 'admin' ? IconBuildingBank : catalogIcon(entry.key);
    return (
      <li key={entry.key}>
        <button
          type="button"
          onClick={() => onAdd(entry.key)}
          // The whole row is the target: a 44px-tall band is far easier to
          // hit on a phone than a trailing icon button would be.
          className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          <Icon
            size={20}
            className="shrink-0 text-gray-500 dark:text-gray-400"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-black dark:text-white">
              {entry.name}
            </span>
            {entry.description && (
              <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                {entry.description}
              </span>
            )}
          </span>
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-gray-500 group-hover:text-black dark:text-gray-400 dark:group-hover:text-white"
          >
            <IconPlus size={14} />
            {t('add')}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="mt-8">
      <h3 className="mb-1 text-base font-semibold text-black dark:text-white">
        {t('addTitle')}
      </h3>
      <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
        {t('addDescription')}
      </p>

      {showFilter && (
        <div className="relative mb-2">
          <IconSearch
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={t('filterLabel')}
            placeholder={t('filterPlaceholder')}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 py-2 pl-9 pr-3 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-blue-500 focus:outline-none"
          />
        </div>
      )}

      {shown.length === 0 ? (
        <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
          {t('noMatches', { query: filter.trim() })}
        </p>
      ) : (
        <>
          {catalogShown.length > 0 && (
            <ul className="-mx-3">{catalogShown.map(renderRow)}</ul>
          )}
          {adminShown.length > 0 && (
            <>
              {/* Only labelled when both groups are present — a lone heading
                  over the only list is a label with nothing to distinguish. */}
              {catalogShown.length > 0 && (
                <p className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {t('adminConnectorsTitle')}
                </p>
              )}
              <ul className="-mx-3">{adminShown.map(renderRow)}</ul>
            </>
          )}
        </>
      )}
    </div>
  );
};
