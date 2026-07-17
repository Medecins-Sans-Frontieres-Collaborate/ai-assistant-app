'use client';

import {
  IconAlertTriangle,
  IconLoader2,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import { FC, useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import type { FoundryResourceTree } from '@/lib/services/agents/ResourceTreeService';

export interface AccountSelection {
  subscriptionId: string;
  resourceGroup: string;
  accountName: string;
}

interface AccountRow extends AccountSelection {
  key: string;
  subscriptionName: string;
  location?: string;
}

interface AccountTreePickerProps {
  tree: FoundryResourceTree | null;
  loading: boolean;
  selection: AccountSelection | null;
  onSelect: (selection: AccountSelection) => void;
  onRetry: () => void;
}

function flattenTree(tree: FoundryResourceTree): AccountRow[] {
  return tree.subscriptions.flatMap((sub) =>
    sub.accounts.map((account) => ({
      key: `${sub.id}/${account.resourceGroup}/${account.name}`,
      subscriptionId: sub.id,
      subscriptionName: sub.name,
      resourceGroup: account.resourceGroup,
      accountName: account.name,
      location: account.location,
    })),
  );
}

function rowMatchesSelection(
  row: AccountRow,
  selection: AccountSelection | null,
): boolean {
  return (
    !!selection &&
    row.subscriptionId === selection.subscriptionId &&
    row.resourceGroup === selection.resourceGroup &&
    row.accountName === selection.accountName
  );
}

/**
 * ACCOUNT-level sibling of ProjectTreePicker (models are deployed on Foundry
 * ACCOUNTS, not projects): renders the server-built, already-pruned resource
 * tree as a searchable radio list of accounts grouped by subscription.
 */
export const AccountTreePicker: FC<AccountTreePickerProps> = ({
  tree,
  loading,
  selection,
  onSelect,
  onRetry,
}) => {
  const t = useTranslations('modelSources');
  const [search, setSearch] = useState('');

  const allRows = useMemo(() => (tree ? flattenTree(tree) : []), [tree]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return allRows;
    return allRows.filter((row) =>
      [row.subscriptionName, row.accountName, row.resourceGroup].some((field) =>
        field.toLowerCase().includes(query),
      ),
    );
  }, [allRows, search]);

  // Group the filtered rows back under their subscription headers.
  const groups = useMemo(() => {
    const bySub = new Map<
      string,
      { subscriptionName: string; rows: AccountRow[] }
    >();
    for (const row of filteredRows) {
      const group = bySub.get(row.subscriptionId) ?? {
        subscriptionName: row.subscriptionName,
        rows: [],
      };
      group.rows.push(row);
      bySub.set(row.subscriptionId, group);
    }
    return [...bySub.entries()].map(([subscriptionId, group]) => ({
      subscriptionId,
      ...group,
    }));
  }, [filteredRows]);

  // A lone discoverable account needs no interaction at all — pick it.
  useEffect(() => {
    if (!loading && allRows.length === 1 && !selection) {
      onSelect(allRows[0]);
    }
  }, [loading, allRows, selection, onSelect]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
        <IconLoader2 size={16} className="animate-spin" />
        {t('scanningResources')}
      </div>
    );
  }

  if (!tree) return null;

  const warnings = (
    <>
      {tree.failedSubscriptions.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {t('discoveryPartialWarning', {
              count: tree.failedSubscriptions.length,
            })}
          </span>
        </div>
      )}
      {tree.truncated && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{t('discoveryTruncatedWarning')}</span>
        </div>
      )}
    </>
  );

  if (allRows.length === 0) {
    return (
      <div className="space-y-2">
        {warnings}
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
          {t('noAccountsDiscovered')}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
        >
          <IconRefresh size={14} />
          {t('retryScan')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {warnings}
      {allRows.length > 5 && (
        <div className="relative">
          <IconSearch
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchAccountsPlaceholder')}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 py-1.5 pl-8 pr-3 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
          />
        </div>
      )}
      <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
        {groups.map((group) => (
          <div key={group.subscriptionId}>
            <div className="sticky top-0 bg-gray-100 dark:bg-gray-800 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {group.subscriptionName}
            </div>
            {group.rows.map((row) => {
              const isSelected = rowMatchesSelection(row, selection);
              return (
                <label
                  key={row.key}
                  className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm ${
                    isSelected
                      ? 'bg-blue-50 dark:bg-blue-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-800/60'
                  }`}
                >
                  <input
                    type="radio"
                    name="foundry-account-picker"
                    checked={isSelected}
                    onChange={() => onSelect(row)}
                    className="h-3.5 w-3.5 shrink-0 accent-blue-600"
                  />
                  <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-white">
                    {row.accountName}
                  </span>
                  {row.location && (
                    <span className="shrink-0 rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                      {row.location}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        ))}
        {filteredRows.length === 0 && (
          <p className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
            {t('noAccountsDiscovered')}
          </p>
        )}
      </div>
    </div>
  );
};
