'use client';

import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
} from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import type {
  M365ManifestFolder,
  M365ManifestItem,
  M365ManifestSource,
} from '@/lib/services/agentAccess/types';

import type { ClientSourcePlan } from './types';

/** Selection fields an admin can change on a source from the plan view. */
export interface SourceSelection {
  recursive: boolean;
  excludedItemIds: string[];
  includeExtensions?: string[];
}

interface M365SourcePlanViewProps {
  kind: 'file' | 'folder';
  selection: SourceSelection;
  plan: ClientSourcePlan | undefined;
  loading: boolean;
  /** The last index run's per-item outcomes for this source, if any. */
  manifestSource?: M365ManifestSource | null;
  onChange: (patch: Partial<SourceSelection>) => void;
}

/** Rows shown per file group before collapsing into "and N more". */
const MAX_ROWS_PER_GROUP = 60;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function parseExtensions(raw: string): string[] | undefined {
  const list = raw
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
    .filter((e) => /^[a-z0-9]{1,10}$/.test(e));
  return list.length > 0 ? [...new Set(list)] : undefined;
}

/**
 * Per-source plan view (design §2–§3): tier chips, the recursive toggle
 * and extension filter, a subfolder list with include checkboxes, and the
 * classified file lists with skip reasons and last-run outcomes.
 */
export const M365SourcePlanView: FC<M365SourcePlanViewProps> = ({
  kind,
  selection,
  plan,
  loading,
  manifestSource,
  onChange,
}) => {
  const t = useTranslations('agentAccess');
  const [expanded, setExpanded] = useState(false);
  const [extensionsDraft, setExtensionsDraft] = useState(
    selection.includeExtensions?.join(', ') ?? '',
  );

  const statusByItem = useMemo(() => {
    const map = new Map<string, M365ManifestItem>();
    for (const item of manifestSource?.items ?? []) {
      map.set(item.itemId, item);
    }
    return map;
  }, [manifestSource]);

  const excluded = useMemo(
    () => new Set(selection.excludedItemIds),
    [selection.excludedItemIds],
  );

  /** Folders sorted by path, with the count of indexable files beneath each. */
  const folderRows = useMemo(() => {
    if (!plan) return [];
    const rows = [...plan.folders].sort((a, b) => a.path.localeCompare(b.path));
    return rows.map((folder) => ({
      folder,
      indexableBelow: plan.items.filter(
        (item) =>
          item.tier === 'indexable' &&
          (item.path === folder.path ||
            item.path.startsWith(`${folder.path}/`)),
      ).length,
      ancestorExcluded: isAncestorExcluded(folder, plan.folders, excluded),
    }));
  }, [plan, excluded]);

  const groups = useMemo(() => {
    const items = plan?.items ?? [];
    const byTier = {
      indexable: items.filter((i) => i.tier === 'indexable'),
      needsPreparation: items.filter((i) => i.tier === 'needsPreparation'),
      skipped: items.filter((i) => i.tier === 'skipped'),
    };
    return byTier;
  }, [plan]);

  const toggleFolder = (itemId: string) => {
    const next = new Set(selection.excludedItemIds);
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    onChange({ excludedItemIds: [...next] });
  };

  const commitExtensions = () => {
    const parsed = parseExtensions(extensionsDraft);
    setExtensionsDraft(parsed?.join(', ') ?? '');
    if (
      (parsed ?? []).join(',') !== (selection.includeExtensions ?? []).join(',')
    ) {
      onChange({ includeExtensions: parsed });
    }
  };

  const chip = (label: string, tone: 'green' | 'amber' | 'gray' | 'red') => {
    const tones = {
      green:
        'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
      amber:
        'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
      gray: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
      red: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    };
    return (
      <span className={`rounded-full px-2 py-0.5 text-xs ${tones[tone]}`}>
        {label}
      </span>
    );
  };

  return (
    <div className="mt-1 space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {loading && !plan && (
          <span className="text-gray-500 dark:text-gray-400">
            {t('m365PlanScanning')}
          </span>
        )}
        {plan?.missing && chip(t('m365PlanMissing'), 'red')}
        {plan && !plan.missing && (
          <>
            {chip(
              t('m365PlanIndexable', { count: plan.counts.indexable }),
              plan.counts.indexable > 0 ? 'green' : 'gray',
            )}
            {plan.counts.needsPreparation > 0 &&
              chip(
                t('m365PlanNeedsPreparation', {
                  count: plan.counts.needsPreparation,
                }),
                'amber',
              )}
            {plan.counts.skipped > 0 &&
              chip(
                t('m365PlanSkipped', { count: plan.counts.skipped }),
                'gray',
              )}
            {plan.counts.bytes > 0 && (
              <span className="text-gray-500 dark:text-gray-400">
                {formatBytes(plan.counts.bytes)}
              </span>
            )}
            {loading && (
              <span className="text-gray-400">{t('m365PlanRefreshing')}</span>
            )}
            {(plan.items.length > 0 || plan.folders.length > 0) && (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                aria-expanded={expanded}
                className="flex items-center gap-0.5 text-blue-700 hover:underline dark:text-blue-400"
              >
                {expanded ? (
                  <IconChevronDown size={12} />
                ) : (
                  <IconChevronRight size={12} />
                )}
                {t(expanded ? 'm365PlanHideDetails' : 'm365PlanShowDetails')}
              </button>
            )}
          </>
        )}
      </div>

      {plan?.truncated && (
        <p className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
          <IconAlertTriangle size={12} /> {t('m365PlanTruncated')}
        </p>
      )}

      {kind === 'folder' && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1 text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={selection.recursive}
              onChange={(e) => onChange({ recursive: e.target.checked })}
            />
            {t('m365PlanRecursive')}
          </label>
          <label className="flex items-center gap-1 text-gray-700 dark:text-gray-300">
            <span>{t('m365PlanExtensionsLabel')}</span>
            <input
              type="text"
              value={extensionsDraft}
              placeholder={t('m365PlanExtensionsPlaceholder')}
              onChange={(e) => setExtensionsDraft(e.target.value)}
              onBlur={commitExtensions}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitExtensions();
                }
              }}
              className="w-40 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-surface-dark-elevated"
            />
          </label>
        </div>
      )}

      {expanded && plan && (
        <div className="space-y-2 rounded-md border border-gray-200 p-2 dark:border-gray-700">
          {folderRows.length > 0 && (
            <div>
              <p className="mb-1 font-semibold text-gray-700 dark:text-gray-300">
                {t('m365PlanSubfolders')}
              </p>
              <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                {folderRows.map(
                  ({ folder, indexableBelow, ancestorExcluded }) => (
                    <li key={folder.itemId}>
                      <label
                        className={`flex items-center gap-1.5 ${
                          ancestorExcluded ? 'opacity-50' : ''
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={
                            !excluded.has(folder.itemId) && !ancestorExcluded
                          }
                          disabled={ancestorExcluded}
                          onChange={() => toggleFolder(folder.itemId)}
                        />
                        <span className="truncate text-gray-800 dark:text-gray-200">
                          {folder.path || folder.name}
                        </span>
                        <span className="shrink-0 text-gray-500 dark:text-gray-400">
                          {t('m365PlanFolderCount', { count: indexableBelow })}
                        </span>
                      </label>
                    </li>
                  ),
                )}
              </ul>
            </div>
          )}

          <FileGroup
            title={t('m365PlanGroupIndexable')}
            items={groups.indexable}
            statusByItem={statusByItem}
            renderNote={(item) => {
              const status = statusByItem.get(item.itemId);
              if (!status?.status) return null;
              return (
                <span
                  className={
                    status.status === 'indexed'
                      ? 'text-green-700 dark:text-green-400'
                      : 'text-red-700 dark:text-red-400'
                  }
                  title={status.error}
                >
                  {t(`m365ItemStatus.${status.status}`)}
                </span>
              );
            }}
          />
          <FileGroup
            title={t('m365PlanGroupNeedsPreparation')}
            items={groups.needsPreparation}
            statusByItem={statusByItem}
            renderNote={() => (
              <span className="text-amber-700 dark:text-amber-400">
                {t('m365PlanPreparationHint')}
              </span>
            )}
          />
          <FileGroup
            title={t('m365PlanGroupSkipped')}
            items={groups.skipped}
            statusByItem={statusByItem}
            renderNote={(item) => (
              <span className="text-gray-500 dark:text-gray-400">
                {t(`m365SkipReason.${item.reason ?? 'unsupported'}`)}
              </span>
            )}
          />
        </div>
      )}
    </div>
  );
};

function isAncestorExcluded(
  folder: M365ManifestFolder,
  folders: M365ManifestFolder[],
  excluded: Set<string>,
): boolean {
  const parentOf = new Map(folders.map((f) => [f.itemId, f.parentItemId]));
  let cursor = parentOf.get(folder.itemId);
  let hops = 0;
  while (cursor && hops < 32) {
    if (excluded.has(cursor)) return true;
    cursor = parentOf.get(cursor);
    hops += 1;
  }
  return false;
}

interface FileGroupProps {
  title: string;
  items: M365ManifestItem[];
  statusByItem: Map<string, M365ManifestItem>;
  renderNote: (item: M365ManifestItem) => React.ReactNode;
}

const FileGroup: FC<FileGroupProps> = ({ title, items, renderNote }) => {
  const t = useTranslations('agentAccess');
  if (items.length === 0) return null;
  const shown = items.slice(0, MAX_ROWS_PER_GROUP);
  return (
    <div>
      <p className="mb-1 font-semibold text-gray-700 dark:text-gray-300">
        {title} ({items.length})
      </p>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {shown.map((item) => (
          <li
            key={item.itemId}
            className="flex items-center gap-2 text-gray-800 dark:text-gray-200"
          >
            <span className="min-w-0 flex-1 truncate" title={item.name}>
              {item.path ? `${item.path}/` : ''}
              {item.name}
            </span>
            <span className="shrink-0 text-gray-400">
              {formatBytes(item.size)}
            </span>
            <span className="shrink-0">{renderNote(item)}</span>
          </li>
        ))}
        {items.length > shown.length && (
          <li className="text-gray-500 dark:text-gray-400">
            {t('m365PlanMoreRows', { count: items.length - shown.length })}
          </li>
        )}
      </ul>
    </div>
  );
};
